import fs from 'fs';
import path from 'path';

const reportPath = '/home/rodrigo/development/prism-service/scratch/audit_compiled_report.json';
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

const critical = report.filter(f => f.severity === '🔴');
const warning = report.filter(f => f.severity === '🟡');

console.log(`=== Critical Findings (${critical.length}) ===`);
critical.forEach((f, idx) => {
  console.log(`${idx + 1}. [${f.file}:${f.lineStart}] - ${f.category}\n   Description: ${f.description}\n   Fix: ${f.fix}\n`);
});

console.log(`=== Warning Findings (${warning.length}) ===`);
warning.forEach((f, idx) => {
  console.log(`${idx + 1}. [${f.file}:${f.lineStart}] - ${f.category}\n   Description: ${f.description}\n   Fix: ${f.fix}\n`);
});
