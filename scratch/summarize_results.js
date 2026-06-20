import fs from 'fs';

const rawData = JSON.parse(fs.readFileSync('/home/rodrigo/development/prism-service/scratch/audit_raw_results.json', 'utf8'));

console.log(`Total files scanned with potential findings: ${rawData.length}`);

// Print files with defined interfaces/types
const filesWithTypes = rawData.filter(r => r.interfaces.length > 0 || r.types.length > 0);
console.log(`\nFiles defining local interfaces/types (${filesWithTypes.length}):`);
filesWithTypes.forEach(r => {
  console.log(`- ${r.file}:`);
  r.interfaces.forEach(i => console.log(`  * Interface [line ${i.line}]: ${i.content}`));
  r.types.forEach(t => console.log(`  * Type [line ${t.line}]: ${t.content}`));
});

// Print some files with many 'as any' assertions or magic strings
const filesWithHardcoded = rawData.filter(r => r.hardcodedStrings.length > 0);
console.log(`\nFiles with hardcoded magic strings (${filesWithHardcoded.length}):`);
filesWithHardcoded.slice(0, 15).forEach(r => {
  console.log(`- ${r.file} (${r.hardcodedStrings.length} instances):`);
  r.hardcodedStrings.slice(0, 5).forEach(s => console.log(`  * Line ${s.line}: "${s.pattern}" in \`${s.content}\``));
});
