import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import MinioWrapper from "#src/wrappers/MinioWrapper";
import { normalizeSkillFilePath } from "./skillFilePaths.ts";

// ────────────────────────────────────────────────────────────
// SkillFolderStore — the files of a SKILL.md folder, stored
// ────────────────────────────────────────────────────────────
// An imported skill keeps its whole folder (SKILL.md, scripts/,
// references/, assets/) so the agent can read a bundled file with
// read_skill_file long after the source is gone. A folder is written once
// and never edited: a re-import writes a new folder and drops the old.
//
//   minio:skill-folders/<uuid>  when MinIO is up (production). Keys are
//                               unguessable and never handed to a client;
//                               the bucket's public-read policy grants
//                               GetObject by exact key only (no listing),
//                               like every other upload Prism stores.
//   file:<uuid>                 otherwise, under PRISM_SKILL_FOLDERS_DIRECTORY
//                               (default ~/.prism/skill-folders).
//
// The skill document carries the manifest (`resources`: path, bytes,
// sha256), so listing a folder never touches storage. Every read
// re-normalizes the path and, on disk, re-checks that the resolved file —
// symlinks followed — is still inside the folder.
// ────────────────────────────────────────────────────────────

export interface SkillFolderFile {
  path: string;
  content: Buffer;
}

/** One file of a stored folder, as the skill document's manifest lists it. */
export interface SkillFolderResource {
  path: string;
  bytes: number;
  sha256: string;
}

export interface StoredSkillFolder {
  folderRef: string;
  resources: SkillFolderResource[];
}

const MINIO_REF_PREFIX = "minio:";
const FILE_REF_PREFIX = "file:";
const MINIO_KEY_ROOT = "skill-folders";
const FOLDER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CONTENT_TYPES: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
};

/** Where folders live on disk when MinIO is not available. */
export function skillFoldersDirectory(): string {
  return path.resolve(
    process.env.PRISM_SKILL_FOLDERS_DIRECTORY || path.join(os.homedir(), ".prism", "skill-folders"),
  );
}

function contentTypeOf(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function byPath(left: { path: string }, right: { path: string }): number {
  if (left.path === right.path) return 0;
  return left.path < right.path ? -1 : 1;
}

/** Normalized, de-duplicated, in byte order. Throws on a path that escapes. */
function normalizeFiles(files: SkillFolderFile[]): SkillFolderFile[] {
  const byNormalizedPath = new Map<string, SkillFolderFile>();
  for (const file of files) {
    const normalized = normalizeSkillFilePath(file.path);
    if ("error" in normalized) throw new Error(normalized.error);
    byNormalizedPath.set(normalized.path, { path: normalized.path, content: file.content });
  }
  return [...byNormalizedPath.values()].sort(byPath);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** The folder a `file:` ref names — only a uuid this store could have written. */
function diskFolderOf(folderRef: string): string {
  const folderId = folderRef.slice(FILE_REF_PREFIX.length);
  if (!FOLDER_ID_PATTERN.test(folderId)) {
    throw new Error(`"${folderRef}" is not a skill folder this store wrote`);
  }
  return path.join(skillFoldersDirectory(), folderId);
}

function minioPrefixOf(folderRef: string): string {
  const prefix = folderRef.slice(MINIO_REF_PREFIX.length);
  const folderId = prefix.slice(MINIO_KEY_ROOT.length + 1);
  if (!prefix.startsWith(`${MINIO_KEY_ROOT}/`) || !FOLDER_ID_PATTERN.test(folderId)) {
    throw new Error(`"${folderRef}" is not a skill folder this store wrote`);
  }
  return prefix;
}

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

function assertRelative(relativePath: string): string {
  const normalized = normalizeSkillFilePath(relativePath);
  if ("error" in normalized) throw new Error(normalized.error);
  return normalized.path;
}

const SkillFolderStore = {
  /** The manifest of a set of files, without storing them. */
  describe(files: SkillFolderFile[]): SkillFolderResource[] {
    return normalizeFiles(files).map((file) => ({
      path: file.path,
      bytes: file.content.length,
      sha256: sha256(file.content),
    }));
  },

  /** Store a folder; returns its ref and manifest. */
  async save(files: SkillFolderFile[]): Promise<StoredSkillFolder> {
    const normalized = normalizeFiles(files);
    const folderId = randomUUID();
    const resources = SkillFolderStore.describe(normalized);

    if (MinioWrapper.isAvailable()) {
      const prefix = `${MINIO_KEY_ROOT}/${folderId}`;
      for (const file of normalized) {
        await MinioWrapper.upload(`${prefix}/${file.path}`, file.content, contentTypeOf(file.path));
      }
      return { folderRef: `${MINIO_REF_PREFIX}${prefix}`, resources };
    }

    const folder = path.join(skillFoldersDirectory(), folderId);
    for (const file of normalized) {
      const target = path.join(folder, ...file.path.split("/"));
      if (!isInside(folder, target)) throw new Error(`"${file.path}" leaves the skill folder`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.content, { flag: "wx" });
    }
    return { folderRef: `${FILE_REF_PREFIX}${folderId}`, resources };
  },

  /** One file of a stored folder. Throws when the path leaves the folder. */
  async read(folderRef: string, relativePath: string): Promise<Buffer> {
    const filePath = assertRelative(relativePath);

    if (folderRef.startsWith(MINIO_REF_PREFIX)) {
      const prefix = minioPrefixOf(folderRef);
      return readStream(await MinioWrapper.get(`${prefix}/${filePath}`));
    }
    if (!folderRef.startsWith(FILE_REF_PREFIX)) {
      throw new Error(`"${folderRef}" is not a skill folder this store wrote`);
    }

    const folder = diskFolderOf(folderRef);
    const target = path.join(folder, ...filePath.split("/"));
    const [realFolder, realTarget] = await Promise.all([fs.realpath(folder), fs.realpath(target)]);
    if (!isInside(realFolder, realTarget)) {
      throw new Error(`"${relativePath}" leaves the skill folder`);
    }
    return fs.readFile(realTarget);
  },

  /** Drop a stored folder (best effort: a missing one is already gone). */
  async remove(folderRef: string | null | undefined): Promise<void> {
    if (!folderRef) return;
    if (folderRef.startsWith(MINIO_REF_PREFIX)) {
      const prefix = minioPrefixOf(folderRef);
      for (const object of await MinioWrapper.listObjects(`${prefix}/`)) {
        await MinioWrapper.remove(object.name);
      }
      return;
    }
    if (folderRef.startsWith(FILE_REF_PREFIX)) {
      await fs.rm(diskFolderOf(folderRef), { recursive: true, force: true });
    }
  },
};

export default SkillFolderStore;
