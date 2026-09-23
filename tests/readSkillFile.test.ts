/**
 * Skill folders through the agent's tools (prompt 19, Landing 2):
 * `load_skill` lists a folder's bundled files, `read_skill_file` returns
 * one, confined to that folder. Every traversal below names a file that
 * EXISTS — a secret beside the folders and another skill's folder — so a
 * naive join would hand it over.
 *
 * Storage is the real SkillService over the in-memory Mongo mock, and the
 * real folder store on its filesystem backend in a temp directory.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMockCollection } from "./mongoMock.ts";

vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    createClient: vi.fn().mockResolvedValue(undefined),
    getDb: vi.fn().mockReturnValue(null),
    getCollection: vi.fn(),
  },
}));

vi.mock("#src/services/EmbeddingService", () => ({
  default: { embed: vi.fn().mockResolvedValue(null) },
}));

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const execSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const count = <T extends (...args: never[]) => unknown>(original: T) =>
    ((...args: Parameters<T>) => {
      execSpy.calls += 1;
      return original(...args);
    }) as T;
  return {
    ...actual,
    exec: count(actual.exec),
    execFile: count(actual.execFile),
    spawn: count(actual.spawn),
  };
});

import MongoWrapper from "#src/wrappers/MongoWrapper";
import { COLLECTIONS } from "#src/constants";
import { requestContext } from "#src/utils/RequestContext";
import skillTools from "#src/services/tool-definitions/SkillTools";
import SkillFolderStore from "#src/services/skills/SkillFolderStore";

type ToolContext = Record<string, unknown>;

function tool(name: string) {
  const found = (
    skillTools as Array<{
      name: string;
      execute: (toolArguments: Record<string, unknown>, context: ToolContext) => Promise<unknown>;
    }>
  ).find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no internal tool named ${name}`);
  return found;
}

function run(name: string, args: Record<string, unknown>, username = "alice") {
  const scope = { project: "prism-chat", username, agent: "CODING" };
  return requestContext.run(
    { ...scope, profileId: "default", clientIp: null },
    () => tool(name).execute(args, scope),
  ) as Promise<any>;
}

let foldersDirectory: string;
let previousDirectory: string | undefined;
let releaseNotesRef: string;
let otherRef: string;
const SECRET = "TOP SECRET — must never leave the server";

beforeAll(async () => {
  previousDirectory = process.env.PRISM_SKILL_FOLDERS_DIRECTORY;
  foldersDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "skill-folders-"));
  process.env.PRISM_SKILL_FOLDERS_DIRECTORY = foldersDirectory;

  const releaseNotes = await SkillFolderStore.save([
    { path: "SKILL.md", content: Buffer.from("---\nname: release-notes\n---\nUse the template.") },
    { path: "references/template.md", content: Buffer.from("## {{version}} — codename WILLOW-7\n") },
    { path: "scripts/collect.sh", content: Buffer.from('#!/bin/sh\ngit log --oneline "$1"..HEAD\n') },
    { path: "assets/logo.png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0xff]) },
  ]);
  releaseNotesRef = releaseNotes.folderRef;
  const other = await SkillFolderStore.save([
    { path: "SKILL.md", content: Buffer.from("Bob's private skill") },
  ]);
  otherRef = other.folderRef;

  // Targets for traversal: beside the folders, and inside another folder.
  await fs.writeFile(path.join(foldersDirectory, "secret.txt"), SECRET);
  await fs.writeFile(path.join(os.tmpdir(), "skill-folders-secret.txt"), SECRET);
});

afterAll(async () => {
  if (previousDirectory === undefined) delete process.env.PRISM_SKILL_FOLDERS_DIRECTORY;
  else process.env.PRISM_SKILL_FOLDERS_DIRECTORY = previousDirectory;
  await fs.rm(foldersDirectory, { recursive: true, force: true });
  await fs.rm(path.join(os.tmpdir(), "skill-folders-secret.txt"), { force: true });
});

describe("skill folders", () => {
  let collection: ReturnType<typeof createMockCollection>;

  beforeEach(async () => {
    execSpy.calls = 0;
    const releaseResources = (
      await SkillFolderStore.describe([
        { path: "SKILL.md", content: Buffer.from("---\nname: release-notes\n---\nUse the template.") },
        { path: "references/template.md", content: Buffer.from("## {{version}} — codename WILLOW-7\n") },
        { path: "scripts/collect.sh", content: Buffer.from('#!/bin/sh\ngit log --oneline "$1"..HEAD\n') },
        { path: "assets/logo.png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0xff]) },
      ])
    );
    collection = createMockCollection([
      {
        _id: "release-notes-1",
        project: "prism-chat",
        username: "alice",
        profileId: "default",
        name: "release-kit:release-notes",
        description: "Write release notes",
        content: "Use the template.",
        enabled: true,
        source: "plugin:release-kit",
        folderRef: releaseNotesRef,
        resources: releaseResources,
      },
      {
        _id: "bob-1",
        project: "prism-chat",
        username: "bob",
        profileId: "default",
        name: "bob-skill",
        description: "Bob's",
        content: "Bob's private skill",
        enabled: true,
        folderRef: otherRef,
        resources: [{ path: "SKILL.md", bytes: 19 }],
      },
      {
        _id: "plain-1",
        project: "prism-chat",
        username: "alice",
        profileId: "default",
        name: "plain",
        description: "No folder",
        content: "Just a body.",
        enabled: true,
      },
    ]);
    vi.mocked(MongoWrapper.getCollection).mockImplementation(
      (_database: string, name: string) =>
        (name === COLLECTIONS.AGENT_SKILLS ? collection : null) as any,
    );
  });

  it("load_skill lists the bundled files (not SKILL.md) and how to read them", async () => {
    const loaded = await run("load_skill", { name: "release-kit:release-notes" });
    expect(loaded.body).toBe("Use the template.");
    expect(loaded.resources).toEqual([
      { path: "assets/logo.png", bytes: 7 },
      { path: "references/template.md", bytes: expect.any(Number) },
      { path: "scripts/collect.sh", bytes: expect.any(Number) },
    ]);
    expect(loaded.hint).toMatch(/read_skill_file/);
  });

  it("load_skill of a skill without a folder has no resources", async () => {
    const loaded = await run("load_skill", { name: "plain" });
    expect(loaded.resources).toEqual([]);
    expect(loaded).not.toHaveProperty("hint");
  });

  it("read_skill_file returns a bundled text file", async () => {
    const result = await run("read_skill_file", {
      skill: "release-kit:release-notes",
      path: "./references//template.md",
    });
    expect(result).toMatchObject({
      skill: "release-kit:release-notes",
      path: "references/template.md",
      content: "## {{version}} — codename WILLOW-7\n",
    });
  });

  it("reading a bundled script returns its text and runs nothing", async () => {
    const result = await run("read_skill_file", {
      skill: "release-kit:release-notes",
      path: "scripts/collect.sh",
    });
    expect(result.content).toContain("git log --oneline");
    expect(result.note).toMatch(/shell tool/);
    expect(result.note).toMatch(/approv/);
    expect(execSpy.calls).toBe(0);
  });

  it("a binary file is described, not dumped", async () => {
    const result = await run("read_skill_file", {
      skill: "release-kit:release-notes",
      path: "assets/logo.png",
    });
    expect(result).toMatchObject({ path: "assets/logo.png", bytes: 7, binary: true });
    expect(result).not.toHaveProperty("content");
  });

  it("names the files there are when the path is not one of them", async () => {
    const result = await run("read_skill_file", {
      skill: "release-kit:release-notes",
      path: "references/missing.md",
    });
    expect(result.error).toMatch(/references\/template\.md/);
  });

  it("a skill without a folder says so", async () => {
    const result = await run("read_skill_file", { skill: "plain", path: "SKILL.md" });
    expect(result.error).toMatch(/no bundled files/);
  });

  it("another user's skill folder is out of reach", async () => {
    const result = await run("read_skill_file", { skill: "bob-skill", path: "SKILL.md" });
    expect(result.error).toMatch(/No skill named/);
    expect(JSON.stringify(result)).not.toContain("Bob's private skill");
  });

  describe("path traversal", () => {
    const attempts = () => [
      "../secret.txt",
      "references/../../secret.txt",
      "..\\secret.txt",
      `../${otherRef.replace(/^file:/, "")}/SKILL.md`,
      "../../skill-folders-secret.txt",
      path.join(foldersDirectory, "secret.txt"),
      path.join(os.tmpdir(), "skill-folders-secret.txt"),
      "~/secret.txt",
    ];

    it("read_skill_file rejects every path that leaves the folder", async () => {
      for (const attempt of attempts()) {
        const result = await run("read_skill_file", {
          skill: "release-kit:release-notes",
          path: attempt,
        });
        expect(result, attempt).toHaveProperty("error");
        expect(JSON.stringify(result), attempt).not.toContain(SECRET);
        expect(JSON.stringify(result), attempt).not.toContain("Bob's private skill");
      }
    });

    it("the folder store refuses them too, without the manifest in front", async () => {
      for (const attempt of attempts()) {
        await expect(SkillFolderStore.read(releaseNotesRef, attempt), attempt).rejects.toThrow(
          /skill folder|absolute/,
        );
      }
    });

    it("the folder store refuses a folderRef that is not one it wrote", async () => {
      await expect(SkillFolderStore.read("file:../..", "secret.txt")).rejects.toThrow(/folder/);
      await expect(
        SkillFolderStore.read(`file:${foldersDirectory}`, "secret.txt"),
      ).rejects.toThrow(/folder/);
    });

    it("a symlink planted inside a folder is not followed out", async () => {
      const folderPath = path.join(foldersDirectory, releaseNotesRef.replace(/^file:/, ""));
      await fs.symlink(path.join(foldersDirectory, "secret.txt"), path.join(folderPath, "link.txt"));
      try {
        await expect(SkillFolderStore.read(releaseNotesRef, "link.txt")).rejects.toThrow(
          /skill folder/,
        );
      } finally {
        await fs.rm(path.join(folderPath, "link.txt"), { force: true });
      }
    });
  });
});
