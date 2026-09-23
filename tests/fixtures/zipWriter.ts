/**
 * A minimal zip writer for tests — just enough of PKWARE's APPNOTE to build
 * the archives the plugin importer reads: local headers, a central
 * directory, stored (0) or deflated (8) entries, no zip64.
 */
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

export interface ZipEntryInput {
  /** The name written into the archive, verbatim (may be hostile). */
  name: string;
  content: Buffer | string;
  method?: 0 | 8;
  /** Unix mode for the external attributes (e.g. 0o120777 for a symlink). */
  unixMode?: number;
  /** Lie about the uncompressed size in both headers. */
  declaredSize?: number;
}

export function writeZip(entries: ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const content = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content, "utf8");
    const method = entry.method ?? 8;
    const data = method === 8 ? zlib.deflateRawSync(content) : content;
    const crc = zlib.crc32(content) >>> 0;
    const size = entry.declaredSize ?? content.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.unixMode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

/** Every file under `directory`, as zip entries under `prefix`. */
export async function zipDirectory(directory: string, prefix = ""): Promise<Buffer> {
  const entries: ZipEntryInput[] = [];
  async function walk(current: string) {
    for (const item of (await fs.readdir(current, { withFileTypes: true })).sort((left, right) =>
      left.name < right.name ? -1 : 1,
    )) {
      const absolute = path.join(current, item.name);
      if (item.isDirectory()) {
        await walk(absolute);
      } else if (item.isFile()) {
        const relative = path.relative(directory, absolute).split(path.sep).join("/");
        const { mode } = await fs.stat(absolute);
        entries.push({
          name: `${prefix}${relative}`,
          content: await fs.readFile(absolute),
          unixMode: 0o100000 | (mode & 0o777),
        });
      }
    }
  }
  await walk(directory);
  return writeZip(entries);
}
