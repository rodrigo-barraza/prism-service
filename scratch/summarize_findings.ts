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

const severityCounts = {
  "🔴": 0,
  "🟡": 0,
  "🔵": 0
};

const categoryCounts: Record<string, typeof severityCounts> = {};

for (const f of findings) {
  severityCounts[f.severity]++;
  if (!categoryCounts[f.category]) {
    categoryCounts[f.category] = { "🔴": 0, "🟡": 0, "🔵": 0 };
  }
  categoryCounts[f.category][f.severity]++;
}

console.log("=== Severity Counts ===");
console.log(JSON.stringify(severityCounts, null, 2));

console.log("\n=== Category Counts ===");
console.log(JSON.stringify(categoryCounts, null, 2));

console.log("\n=== Critical (🔴) findings ===");
const criticals = findings.filter(f => f.severity === "🔴");
for (const f of criticals) {
  console.log(`- File: ${f.file} (${f.lineRange})`);
  console.log(`  Category: ${f.category}`);
  console.log(`  Source: ${f.sourceOfTruth}`);
  console.log(`  Desc: ${f.description.replace(/\n/g, " ")}`);
  console.log(`  Fix: ${f.fix}`);
  console.log("");
}
