import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ────────────────────────────────────────────────────────────
// Locale Key Parity — Structural Integrity Test
// ────────────────────────────────────────────────────────────
// Enforces that every non-English locale has the exact same
// keys as the English (en) source-of-truth locale.
// English is canonical — all other locales must match 1:1.
//
// Recursively scans all JSON files including subdirectories
// (e.g., personas/) to ensure complete coverage.
// ────────────────────────────────────────────────────────────

const currentFilePath = fileURLToPath(import.meta.url);
const localesRootDirectory = path.resolve(
  path.dirname(currentFilePath),
  "..",
  "..",
  "locales",
);

function deepFlattenKeys(
  source: Record<string, unknown>,
  prefix = "",
): string[] {
  const flattenedKeys: string[] = [];

  for (const [key, value] of Object.entries(source)) {
    const flatKey = prefix ? `${prefix}.${key}` : key;

    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      flattenedKeys.push(
        ...deepFlattenKeys(value as Record<string, unknown>, flatKey),
      );
    } else {
      flattenedKeys.push(flatKey);
    }
  }

  return flattenedKeys.sort();
}

function loadFlattenedJsonKeys(filePath: string): string[] {
  const rawContent = fs.readFileSync(filePath, "utf-8");
  const parsedContent = JSON.parse(rawContent) as Record<string, unknown>;
  return deepFlattenKeys(parsedContent);
}

function discoverLocaleDirectories(): string[] {
  if (!fs.existsSync(localesRootDirectory)) {
    return [];
  }

  return fs
    .readdirSync(localesRootDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !entry.name.startsWith("__") && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Recursively discovers all JSON files under a locale directory,
 * returning paths relative to the locale root (e.g., "harness.json",
 * "personas/lupos.json").
 */
function discoverJsonFilesRecursively(
  localeDirectory: string,
  relativePath = "",
): string[] {
  const absolutePath = path.join(localeDirectory, relativePath);

  if (!fs.existsSync(absolutePath)) {
    return [];
  }

  const entries = fs.readdirSync(absolutePath, { withFileTypes: true });
  const jsonFiles: string[] = [];

  for (const entry of entries) {
    const entryRelativePath = relativePath
      ? `${relativePath}/${entry.name}`
      : entry.name;

    if (entry.isDirectory()) {
      jsonFiles.push(
        ...discoverJsonFilesRecursively(localeDirectory, entryRelativePath),
      );
    } else if (entry.name.endsWith(".json")) {
      jsonFiles.push(entryRelativePath);
    }
  }

  return jsonFiles.sort();
}

describe("PromptLocaleService — Key Parity", () => {
  const availableLocales = discoverLocaleDirectories();
  const nonEnglishLocales = availableLocales.filter(
    (localeName) => localeName !== "en",
  );
  const englishLocaleDirectory = path.join(localesRootDirectory, "en");
  const englishJsonFiles = discoverJsonFilesRecursively(englishLocaleDirectory);

  it("should have at least the English locale", () => {
    expect(availableLocales).toContain("en");
  });

  it("should have at least one non-English locale", () => {
    expect(nonEnglishLocales.length).toBeGreaterThan(0);
  });

  it("should have at least 10 JSON files in the English locale", () => {
    expect(
      englishJsonFiles.length,
      `Expected at least 10 JSON files in en/, found ${englishJsonFiles.length}: ${englishJsonFiles.join(", ")}`,
    ).toBeGreaterThanOrEqual(10);
  });

  describe.each(nonEnglishLocales)("locale '%s'", (localeName) => {
    const localeDirectory = path.join(localesRootDirectory, localeName);
    const localeJsonFiles = discoverJsonFilesRecursively(localeDirectory);

    it("should have every JSON file that English has", () => {
      const missingFiles = englishJsonFiles.filter(
        (fileName) => !localeJsonFiles.includes(fileName),
      );

      expect(
        missingFiles,
        `Locale "${localeName}" is missing JSON file(s) that exist in "en": ${missingFiles.join(", ")}`,
      ).toEqual([]);
    });

    it("should NOT have extra JSON files that English does not have", () => {
      const extraFiles = localeJsonFiles.filter(
        (fileName) => !englishJsonFiles.includes(fileName),
      );

      expect(
        extraFiles,
        `Locale "${localeName}" has extra JSON file(s) not in "en": ${extraFiles.join(", ")}`,
      ).toEqual([]);
    });

    describe.each(englishJsonFiles)("file '%s'", (jsonFileName) => {
      const englishFilePath = path.join(englishLocaleDirectory, jsonFileName);
      const localeFilePath = path.join(localeDirectory, jsonFileName);

      it("should exist in the locale directory", () => {
        expect(
          fs.existsSync(localeFilePath),
          `Missing file: locales/${localeName}/${jsonFileName}`,
        ).toBe(true);
      });

      it("should be valid JSON", () => {
        if (!fs.existsSync(localeFilePath)) return;

        expect(() => {
          const rawContent = fs.readFileSync(localeFilePath, "utf-8");
          JSON.parse(rawContent);
        }).not.toThrow();
      });

      it("should have the exact same number of keys as English", () => {
        if (!fs.existsSync(localeFilePath)) return;

        const englishKeys = loadFlattenedJsonKeys(englishFilePath);
        const localeKeys = loadFlattenedJsonKeys(localeFilePath);

        expect(
          localeKeys.length,
          `Key count mismatch in "${localeName}/${jsonFileName}": EN has ${englishKeys.length} keys, ${localeName} has ${localeKeys.length} keys`,
        ).toBe(englishKeys.length);
      });

      it("should have the exact same keys as English (no missing, no extra)", () => {
        if (!fs.existsSync(localeFilePath)) return;

        const englishKeys = loadFlattenedJsonKeys(englishFilePath);
        const localeKeys = loadFlattenedJsonKeys(localeFilePath);

        const englishKeySet = new Set(englishKeys);
        const localeKeySet = new Set(localeKeys);

        const missingFromLocale = englishKeys.filter(
          (key) => !localeKeySet.has(key),
        );
        const extraInLocale = localeKeys.filter(
          (key) => !englishKeySet.has(key),
        );

        if (missingFromLocale.length > 0 || extraInLocale.length > 0) {
          const errorLines: string[] = [
            `Key mismatch in "${localeName}/${jsonFileName}":`,
          ];

          if (missingFromLocale.length > 0) {
            errorLines.push(
              `  Missing from ${localeName} (${missingFromLocale.length}):`,
            );
            for (const key of missingFromLocale.slice(0, 25)) {
              errorLines.push(`    - ${key}`);
            }
            if (missingFromLocale.length > 25) {
              errorLines.push(
                `    ... and ${missingFromLocale.length - 25} more`,
              );
            }
          }

          if (extraInLocale.length > 0) {
            errorLines.push(
              `  Extra in ${localeName} (not in EN) (${extraInLocale.length}):`,
            );
            for (const key of extraInLocale.slice(0, 25)) {
              errorLines.push(`    + ${key}`);
            }
            if (extraInLocale.length > 25) {
              errorLines.push(
                `    ... and ${extraInLocale.length - 25} more`,
              );
            }
          }

          expect.fail(errorLines.join("\n"));
        }
      });

      it("should not have empty string values (untranslated placeholders)", () => {
        if (!fs.existsSync(localeFilePath)) return;

        const rawContent = fs.readFileSync(localeFilePath, "utf-8");
        const parsedContent = JSON.parse(rawContent) as Record<string, unknown>;

        function findEmptyValues(
          source: Record<string, unknown>,
          prefix = "",
        ): string[] {
          const emptyKeys: string[] = [];

          for (const [key, value] of Object.entries(source)) {
            const flatKey = prefix ? `${prefix}.${key}` : key;

            if (
              value !== null &&
              typeof value === "object" &&
              !Array.isArray(value)
            ) {
              emptyKeys.push(
                ...findEmptyValues(value as Record<string, unknown>, flatKey),
              );
            } else if (typeof value === "string" && value.trim() === "") {
              emptyKeys.push(flatKey);
            }
          }

          return emptyKeys;
        }

        const emptyValueKeys = findEmptyValues(parsedContent);

        expect(
          emptyValueKeys,
          `Empty string values found in "${localeName}/${jsonFileName}" (likely untranslated): ${emptyValueKeys.join(", ")}`,
        ).toEqual([]);
      });

      it("should preserve template variables ({{varName}}) from English", () => {
        if (!fs.existsSync(localeFilePath)) return;

        const englishContent = JSON.parse(
          fs.readFileSync(englishFilePath, "utf-8"),
        ) as Record<string, unknown>;
        const localeContent = JSON.parse(
          fs.readFileSync(localeFilePath, "utf-8"),
        ) as Record<string, unknown>;

        const templateVariablePattern = /\{\{(\w+)\}\}/g;

        function extractTemplateVariables(
          source: Record<string, unknown>,
          prefix = "",
        ): Map<string, Set<string>> {
          const variablesByKey = new Map<string, Set<string>>();

          for (const [key, value] of Object.entries(source)) {
            const flatKey = prefix ? `${prefix}.${key}` : key;

            if (
              value !== null &&
              typeof value === "object" &&
              !Array.isArray(value)
            ) {
              const nestedVariables = extractTemplateVariables(
                value as Record<string, unknown>,
                flatKey,
              );
              for (const [nestedKey, variables] of nestedVariables) {
                variablesByKey.set(nestedKey, variables);
              }
            } else if (typeof value === "string") {
              const matches = [...value.matchAll(templateVariablePattern)];
              if (matches.length > 0) {
                variablesByKey.set(
                  flatKey,
                  new Set(matches.map((match) => match[1])),
                );
              }
            }
          }

          return variablesByKey;
        }

        const englishVariables = extractTemplateVariables(englishContent);
        const localeVariables = extractTemplateVariables(localeContent);
        const mismatchedKeys: string[] = [];

        for (const [key, expectedVariables] of englishVariables) {
          const actualVariables = localeVariables.get(key);

          if (!actualVariables) {
            mismatchedKeys.push(
              `${key}: expected {{${[...expectedVariables].join("}}, {{")}}} but locale has no template variables`,
            );
            continue;
          }

          const missingVariables = [...expectedVariables].filter(
            (variable) => !actualVariables.has(variable),
          );
          const extraVariables = [...actualVariables].filter(
            (variable) => !expectedVariables.has(variable),
          );

          if (missingVariables.length > 0 || extraVariables.length > 0) {
            const parts: string[] = [`${key}:`];
            if (missingVariables.length > 0) {
              parts.push(`missing {{${missingVariables.join("}}, {{")}}}}`);
            }
            if (extraVariables.length > 0) {
              parts.push(`extra {{${extraVariables.join("}}, {{")}}}}`);
            }
            mismatchedKeys.push(parts.join(" "));
          }
        }

        expect(
          mismatchedKeys,
          `Template variable mismatches in "${localeName}/${jsonFileName}":\n${mismatchedKeys.join("\n")}`,
        ).toEqual([]);
      });
    });
  });
});
