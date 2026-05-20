/**
 * refactor_any3.cjs — Final aggressive pass: replace ALL remaining `as any` patterns.
 * Uses a single universal regex per category with order-of-precedence.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const SRC = path.join(__dirname, "src");

const files = execSync(`find ${SRC} -name '*.ts' -type f`)
  .toString()
  .trim()
  .split("\n")
  .filter(Boolean);

let totalReplacements = 0;
let filesModified = 0;

for (const file of files) {
  let content = fs.readFileSync(file, "utf8");
  const original = content;
  let count = 0;

  // 1. `as any` followed by property access → Record cast
  //    Matches: `as any).`, `as any)?.`, `as any)[`, `as any | number`
  content = content.replace(/\bas any\b(\)[\?.])/g, (m, after) => {
    count++;
    return `as Record<string, unknown>${after}`;
  });

  // 2. `as any` followed by `)` → value cast
  content = content.replace(/\bas any\b\)/g, () => {
    count++;
    return "as unknown)";
  });

  // 3. All remaining `as any` (end of line, semicolons, commas, etc)
  content = content.replace(/\bas any\b/g, () => {
    count++;
    return "as unknown";
  });

  // 4. `: any` in type positions (params, variables, return types)
  //    Skip z.any(), "any" strings, and comments
  const lines = content.split("\n");
  const processed = lines.map((line) => {
    // Skip comment-only lines
    if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) return line;
    // Skip string content containing 'any' 
    if (line.includes('"any"') || line.includes("'any'") || line.includes('`any')) return line;
    // Skip z.any() — Zod API
    if (line.includes("z.any()")) return line;
    // Skip imports
    if (line.trimStart().startsWith("import")) return line;
    
    // Replace `: any` type annotations
    const replaced = line.replace(/:\s*any\b(?!\s*\()/g, (match) => {
      count++;
      return match.replace("any", "unknown");
    });
    return replaced;
  });
  content = processed.join("\n");

  if (content !== original) {
    fs.writeFileSync(file, content, "utf8");
    filesModified++;
    totalReplacements += count;
    const rel = path.relative(__dirname, file);
    console.log(`  ✅ ${rel} — ${count} replacements`);
  }
}

console.log(`\n🏁 Done: ${totalReplacements} replacements across ${filesModified} files`);
