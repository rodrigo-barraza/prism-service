/**
 * promptRetirement.test.ts
 *
 * docs/prompts/README.md §Retirement: a landed section is deleted (heading
 * included) and recorded at the top of its prompt; the last landing deletes
 * the file and its index row. Landings retired in parallel each see the
 * others still open, so none of them deletes the file — prompt 09's three
 * landings merged in one batch on 2026-09-22 and left a file of three "Done"
 * sections behind. This test is where that state shows up: in the batch that
 * merges the last retirement.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PROMPTS = join(import.meta.dirname, "..", "docs", "prompts");

const LANDING_HEADING = /^## Landing (\d+)\b.*$/gm;
const RETIREMENT_RECORD = /^> \*\*Landing \d+\b/m;
const DONE_BODY = /^\**Done\b/;

/** What §Retirement says is still owed on one prompt file. */
function retirementProblems(name: string, text: string): string[] {
  const headings = [...text.matchAll(LANDING_HEADING)];
  const problems: string[] = [];
  let open = 0;
  for (const [index, heading] of headings.entries()) {
    const start = heading.index + heading[0].length;
    const end = headings[index + 1]?.index ?? text.length;
    const body = text.slice(start, end).trimStart();
    if (DONE_BODY.test(body)) {
      problems.push(`${name}: Landing ${heading[1]} is marked done in place — delete its section and record it at the top`);
    } else {
      open++;
    }
  }
  if (open === 0 && (headings.length > 0 || RETIREMENT_RECORD.test(text))) {
    problems.push(`${name}: every landing is retired — delete the file and its README index row`);
  }
  return problems;
}

function promptFiles(): string[] {
  return readdirSync(PROMPTS).filter((name) => /^\d+-.*\.md$/.test(name)).sort();
}

describe("docs/prompts retirement", () => {
  it("no prompt is left behind after its last landing", () => {
    const problems = promptFiles().flatMap((name) =>
      retirementProblems(name, readFileSync(join(PROMPTS, name), "utf8")),
    );
    expect(problems).toEqual([]);
  });

  it("the README index lists exactly the prompt files present", () => {
    const readme = readFileSync(join(PROMPTS, "README.md"), "utf8");
    const indexed = [...readme.matchAll(/^\| \d+ \| `([^`]+\.md)` \|/gm)].map((match) => match[1]).sort();
    expect(indexed).toEqual(promptFiles());
  });

  describe("the detector", () => {
    const header = "# 99 — Example (three landings)\n\n> Hand to ONE session per landing.\n\n";
    const section = (n: number, body: string) => `## Landing ${n} — \`slug-${n}\`\n\n${body}\n\n---\n\n`;
    const record = (n: number) => `> **Landing ${n} (\`slug-${n}\`) done 2026-09-22.** What it did.\n\n`;

    it("passes a prompt with a landing still open", () => {
      const text = header + record(1) + section(2, "Work to do.") + section(3, "More work.");
      expect(retirementProblems("99.md", text)).toEqual([]);
    });

    it("passes a single-landing prompt, which has no landing sections", () => {
      expect(retirementProblems("99.md", "# 99 — Example\n\n## Changes\n\nWork to do.\n")).toEqual([]);
    });

    it("flags a landing marked done in its own section", () => {
      const text = header + section(1, "**Done 2026-09-22:** what it did.") + section(2, "Work to do.");
      expect(retirementProblems("99.md", text)).toEqual([
        "99.md: Landing 1 is marked done in place — delete its section and record it at the top",
      ]);
    });

    it("flags a prompt whose every landing was retired in place (prompt 09)", () => {
      const text = header + section(1, "**Done 2026-09-22:** a.") + section(2, "**Done 2026-09-22:** b.") + section(3, "Done: c.");
      expect(retirementProblems("99.md", text)).toContain(
        "99.md: every landing is retired — delete the file and its README index row",
      );
    });

    it("flags a prompt whose parallel retirements removed every section", () => {
      const text = header + record(1) + record(2) + record(3) + "## Done when (each landing)\n\n- Green.\n";
      expect(retirementProblems("99.md", text)).toEqual([
        "99.md: every landing is retired — delete the file and its README index row",
      ]);
    });
  });
});
