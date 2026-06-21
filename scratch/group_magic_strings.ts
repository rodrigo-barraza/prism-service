import * as fs from "fs";

interface Finding {
  category: string;
  file: string;
  lineRange: string;
  severity: "🔴" | "🟡" | "🔵";
  sourceOfTruth: string;
  description: string;
  fix: string;
}

const findings: Finding[] = JSON.parse(fs.readFileSync("scratch/audit_findings.json", "utf8"));
const magic = findings.filter(f => f.category === "Hard-Coded Magic Strings & Values");

// Group by constant type (PROVIDERS, COLLECTIONS, TYPES, etc.)
const groups: Record<string, number> = {};
const fileCounts: Record<string, number> = {};

for (const f of magic) {
  const source = f.sourceOfTruth.split(" → ")[1] || "Other";
  const category = source.split(".")[0] || "Other";
  groups[category] = (groups[category] || 0) + 1;
  fileCounts[f.file] = (fileCounts[f.file] || 0) + 1;
}

console.log("=== Constants Group Counts ===");
console.log(JSON.stringify(groups, null, 2));

console.log("\n=== Top Files with Magic Strings ===");
const sortedFiles = Object.entries(fileCounts).sort((a, b) => b[1] - a[1]);
console.log(JSON.stringify(sortedFiles.slice(0, 15), null, 2));
