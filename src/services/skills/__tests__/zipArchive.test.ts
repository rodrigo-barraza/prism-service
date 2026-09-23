/**
 * The plugin importer's zip reader: stored and deflated entries, and the
 * archives it must refuse — entries that climb out of the archive (zip
 * slip), absolute names, symlinks, and sizes past the limits.
 */
import { describe, it, expect } from "vitest";
import { readZipArchive } from "../zipArchive.ts";
import { writeZip } from "../../../../tests/fixtures/zipWriter.ts";

const text = (buffer: Buffer | undefined) => buffer?.toString("utf8");

describe("readZipArchive", () => {
  it("reads stored and deflated entries, directories skipped", () => {
    const archive = writeZip([
      { name: "plugin/", content: "" },
      { name: "plugin/plugin.json", content: '{"name":"x"}', method: 0 },
      { name: "plugin/skills/a/SKILL.md", content: "# A\n".repeat(200), method: 8 },
    ]);
    const result = readZipArchive(archive);
    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.files.map((file) => file.path)).toEqual([
      "plugin/plugin.json",
      "plugin/skills/a/SKILL.md",
    ]);
    expect(text(result.files[0].content)).toBe('{"name":"x"}');
    expect(text(result.files[1].content)).toBe("# A\n".repeat(200));
  });

  it.each([
    ["../evil.txt"],
    ["plugin/../../evil.txt"],
    ["/etc/cron.d/evil"],
    ["C:\\evil.txt"],
    ["plugin\\..\\..\\evil.txt"],
  ])("refuses the archive for an entry named %j (zip slip)", (name) => {
    const archive = writeZip([
      { name: "plugin/plugin.json", content: "{}" },
      { name, content: "pwned" },
    ]);
    const result = readZipArchive(archive);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/unsafe entry/);
  });

  it("skips a symlink entry instead of materializing it", () => {
    const archive = writeZip([
      { name: "plugin/plugin.json", content: "{}" },
      { name: "plugin/link", content: "/etc/passwd", unixMode: 0o120777 },
    ]);
    const result = readZipArchive(archive);
    if ("error" in result) throw new Error(result.error);
    expect(result.files.map((file) => file.path)).toEqual(["plugin/plugin.json"]);
    expect(result.skipped).toEqual([{ path: "plugin/link", reason: "symbolic link" }]);
  });

  it("refuses more uncompressed bytes than the limit (zip bomb)", () => {
    const archive = writeZip([{ name: "big.txt", content: Buffer.alloc(64 * 1024) }]);
    const result = readZipArchive(archive, { maxTotalBytes: 1024 });
    expect((result as { error: string }).error).toMatch(/larger than/);
  });

  it("refuses an entry that inflates past the size it declares", () => {
    const archive = writeZip([
      { name: "liar.txt", content: Buffer.alloc(64 * 1024), declaredSize: 10 },
    ]);
    const result = readZipArchive(archive);
    expect(result).toHaveProperty("error");
  });

  it("refuses more entries than the limit", () => {
    const archive = writeZip(
      Array.from({ length: 5 }, (_, index) => ({ name: `f${index}.txt`, content: "x" })),
    );
    expect((readZipArchive(archive, { maxEntries: 3 }) as { error: string }).error).toMatch(
      /entries/,
    );
  });

  it("refuses something that is not a zip", () => {
    expect(readZipArchive(Buffer.from("definitely not a zip file"))).toHaveProperty("error");
  });
});
