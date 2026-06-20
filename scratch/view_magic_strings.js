import fs from 'fs';

const report = JSON.parse(fs.readFileSync('/home/rodrigo/development/prism-service/scratch/audit_compiled_report.json', 'utf8'));
const magicStrings = report.filter(r => r.category === 'Hard-Coded Magic Strings & Values');

console.log(`Found ${magicStrings.length} magic strings:`);
const grouped = {};
for (const item of magicStrings) {
  grouped[item.file] = grouped[item.file] || [];
  grouped[item.file].push(item);
}

for (const [file, items] of Object.entries(grouped)) {
  console.log(`\nFile: ${file} (${items.length} findings)`);
  items.slice(0, 5).forEach(item => {
    console.log(`  * Line ${item.lineStart}: ${item.description}`);
  });
  if (items.length > 5) {
    console.log(`  * ... and ${items.length - 5} more`);
  }
}
