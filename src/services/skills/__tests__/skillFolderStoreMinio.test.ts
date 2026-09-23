/**
 * SkillFolderStore's MinIO backend — the one production uses — over an
 * in-memory bucket: a folder is written under skill-folders/<uuid>/, read
 * back by exact key, refused a path that leaves it, and removed whole.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "node:stream";

const bucket = vi.hoisted(() => new Map<string, { content: Buffer; contentType: string }>());

vi.mock("#src/wrappers/MinioWrapper", () => ({
  default: {
    isAvailable: () => true,
    upload: async (key: string, content: Buffer, contentType: string) => {
      bucket.set(key, { content, contentType });
    },
    get: async (key: string) => {
      const object = bucket.get(key);
      if (!object) throw new Error(`NoSuchKey: ${key}`);
      return Readable.from([object.content]);
    },
    listObjects: async (prefix: string) =>
      [...bucket.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((name) => ({ name, size: bucket.get(name)!.content.length, lastModified: new Date() })),
    remove: async (key: string) => {
      bucket.delete(key);
    },
  },
}));

import SkillFolderStore from "../SkillFolderStore.ts";

const files = [
  { path: "SKILL.md", content: Buffer.from("Use the template.") },
  { path: "references/template.md", content: Buffer.from("## {{version}} — WILLOW-7\n") },
];

describe("SkillFolderStore on MinIO", () => {
  beforeEach(() => bucket.clear());

  it("writes a folder under an unguessable prefix and reads it back", async () => {
    const other = await SkillFolderStore.save([{ path: "SKILL.md", content: Buffer.from("other") }]);
    const folder = await SkillFolderStore.save(files);

    expect(folder.folderRef).toMatch(/^minio:skill-folders\/[0-9a-f-]{36}$/);
    expect(folder.folderRef).not.toBe(other.folderRef);
    const prefix = folder.folderRef.slice("minio:".length);
    expect(bucket.get(`${prefix}/references/template.md`)?.contentType).toBe("text/markdown; charset=utf-8");
    expect(folder.resources.map((resource) => resource.path)).toEqual(["SKILL.md", "references/template.md"]);

    const template = await SkillFolderStore.read(folder.folderRef, "./references//template.md");
    expect(template.toString("utf8")).toContain("WILLOW-7");
  });

  it("refuses a path that leaves the folder, and a ref it did not write", async () => {
    const folder = await SkillFolderStore.save(files);
    const other = await SkillFolderStore.save([{ path: "SKILL.md", content: Buffer.from("other") }]);
    const otherId = other.folderRef.split("/").pop();

    for (const attempt of ["../SKILL.md", `../${otherId}/SKILL.md`, "/skill-folders/x", "C:\\x"]) {
      await expect(SkillFolderStore.read(folder.folderRef, attempt), attempt).rejects.toThrow(
        /skill folder|absolute/,
      );
    }
    await expect(SkillFolderStore.read("minio:skill-folders/..", "SKILL.md")).rejects.toThrow(/folder/);
    await expect(SkillFolderStore.read("minio:other-bucket-prefix/x", "SKILL.md")).rejects.toThrow(
      /folder/,
    );
  });

  it("removes every object of a folder and nothing else", async () => {
    const folder = await SkillFolderStore.save(files);
    const other = await SkillFolderStore.save([{ path: "SKILL.md", content: Buffer.from("other") }]);
    await SkillFolderStore.remove(folder.folderRef);

    const left = [...bucket.keys()];
    expect(left).toHaveLength(1);
    expect(left[0].startsWith(other.folderRef.slice("minio:".length))).toBe(true);
  });
});
