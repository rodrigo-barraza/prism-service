import fs from 'fs';
import path from 'path';

const filePath = '/home/rodrigo/development/prism-service/tests/costCalculation.test.ts';
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log(`Scanning ${filePath} (${lines.length} lines)...`);

// Find any interface or type declarations
const types = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (/^\s*(interface|type)\s+/.test(line)) {
    types.push({ line: i + 1, content: line.trim() });
  }
}

console.log(`\nLocal Types/Interfaces (${types.length}):`);
types.forEach(t => console.log(`  * Line ${t.line}: ${t.content}`));

// Check for mocks
const mocks = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.includes('vi.mock(') || line.includes('vi.spyOn(')) {
    mocks.push({ line: i + 1, content: line.trim() });
  }
}
console.log(`\nMocks (${mocks.length}):`);
mocks.forEach(m => console.log(`  * Line ${m.line}: ${m.content}`));
