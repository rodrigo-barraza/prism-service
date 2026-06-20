import fs from 'fs';

const report = JSON.parse(fs.readFileSync('/home/rodrigo/development/prism-service/scratch/audit_compiled_report.json', 'utf8'));
const anyAssertions = report.filter(r => r.category === 'Stale Mock Contracts');

console.log(`Found ${anyAssertions.length} type assertions/mock cases:`);
anyAssertions.forEach((r, idx) => {
  console.log(`[${idx + 1}] File: ${r.file}:${r.lineStart}`);
  console.log(`    Line: ${r.description}`);
});
