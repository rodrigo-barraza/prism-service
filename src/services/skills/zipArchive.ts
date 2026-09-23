import zlib from "node:zlib";
import { normalizeSkillFilePath } from "./skillFilePaths.ts";

// ────────────────────────────────────────────────────────────
// zipArchive — read an uploaded plugin zip, in memory, bounded
// ────────────────────────────────────────────────────────────
// Just enough of PKWARE's APPNOTE for plugin archives: the central
// directory, stored (0) and deflated (8) entries, UTF-8 names. No zip64,
// no encryption. An archive is refused whole when any entry name would
// land outside it (zip slip) or it is bigger than the limits; symlink
// entries are skipped, never materialized. Every entry is inflated with a
// hard output cap and checked against its declared size and CRC-32.
// ────────────────────────────────────────────────────────────

export interface ZipFile {
  path: string;
  content: Buffer;
  /** Permission bits from a Unix-made archive (e.g. 0o755), else absent. */
  mode?: number;
}

export interface ZipLimits {
  maxEntries: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 2_000,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
};

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const MAX_COMMENT_BYTES = 0xffff;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_SYMLINK = 0o120000;
const MADE_BY_UNIX = 3;

function findEndOfCentralDirectory(archive: Buffer): number {
  const earliest = Math.max(0, archive.length - 22 - MAX_COMMENT_BYTES);
  for (let offset = archive.length - 22; offset >= earliest; offset -= 1) {
    if (archive.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  return -1;
}

export function readZipArchive(
  archive: Buffer,
  limits: Partial<ZipLimits> = {},
): { files: ZipFile[]; skipped: Array<{ path: string; reason: string }> } | { error: string } {
  const { maxEntries, maxFileBytes, maxTotalBytes } = { ...DEFAULT_ZIP_LIMITS, ...limits };
  if (archive.length < 22) return { error: "not a zip archive (too short)" };
  const end = findEndOfCentralDirectory(archive);
  if (end < 0) return { error: "not a zip archive (no end-of-central-directory record)" };

  const entryCount = archive.readUInt16LE(end + 10);
  const directorySize = archive.readUInt32LE(end + 12);
  const directoryOffset = archive.readUInt32LE(end + 16);
  if (entryCount === 0xffff || directoryOffset === 0xffffffff) {
    return { error: "zip64 archives are not supported" };
  }
  if (entryCount > maxEntries) {
    return { error: `the archive has ${entryCount} entries (limit ${maxEntries})` };
  }
  if (directoryOffset + directorySize > end) return { error: "corrupt zip (central directory)" };

  const files: ZipFile[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  let cursor = directoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > end || archive.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_HEADER) {
      return { error: "corrupt zip (central directory entry)" };
    }
    const madeBy = archive.readUInt16LE(cursor + 4) >> 8;
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const crc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const declaredSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const rawName = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;

    if (rawName.endsWith("/") || rawName.endsWith("\\")) {
      // A directory entry: its path still has to stay inside the archive.
      if (rawName.replace(/[\\/]+$/, "") !== "" && "error" in normalizeSkillFilePath(rawName)) {
        return { error: `unsafe entry "${rawName}": it would land outside the archive` };
      }
      continue;
    }
    const normalized = normalizeSkillFilePath(rawName);
    if ("error" in normalized) {
      return { error: `unsafe entry "${rawName}": it would land outside the archive` };
    }
    const entryPath = normalized.path;
    if (madeBy === MADE_BY_UNIX && ((externalAttributes >>> 16) & UNIX_FILE_TYPE_MASK) === UNIX_SYMLINK) {
      skipped.push({ path: entryPath, reason: "symbolic link" });
      continue;
    }
    if (flags & 0x1) return { error: `entry "${entryPath}" is encrypted` };
    if (method !== 0 && method !== 8) {
      return { error: `entry "${entryPath}" uses compression method ${method} (only stored and deflate)` };
    }
    if (declaredSize > maxFileBytes) {
      return { error: `entry "${entryPath}" is larger than ${maxFileBytes} bytes` };
    }
    totalBytes += declaredSize;
    if (totalBytes > maxTotalBytes) {
      return { error: `the archive unpacks to more than ${maxTotalBytes} bytes (larger than the limit)` };
    }
    if (seen.has(entryPath)) return { error: `the archive holds "${entryPath}" twice` };
    seen.add(entryPath);

    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) {
      return { error: `corrupt zip (local header of "${entryPath}")` };
    }
    const dataStart =
      localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
    const data = archive.subarray(dataStart, dataStart + compressedSize);
    if (data.length !== compressedSize) return { error: `corrupt zip (data of "${entryPath}")` };

    let content: Buffer;
    try {
      content =
        method === 0
          ? Buffer.from(data)
          : zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, declaredSize) });
    } catch {
      return { error: `entry "${entryPath}" inflates past the size it declares, or is corrupt` };
    }
    if (content.length !== declaredSize) {
      return { error: `entry "${entryPath}" is not the size it declares` };
    }
    if ((zlib.crc32(content) >>> 0) !== crc) {
      return { error: `entry "${entryPath}" fails its CRC-32 check` };
    }
    const mode = madeBy === MADE_BY_UNIX ? (externalAttributes >>> 16) & 0o777 : 0;
    files.push({ path: entryPath, content, ...(mode ? { mode } : {}) });
  }

  return { files, skipped };
}
