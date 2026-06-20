import fs from 'fs';
import path from 'path';

const WORKSPACE_DIR = '/home/rodrigo/development/prism-service';
const TESTS_DIR = path.join(WORKSPACE_DIR, 'tests');

function walkDir(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      if (file !== 'node_modules' && file !== 'scratch') {
        walkDir(filePath, fileList);
      }
    } else if (file.endsWith('.test.ts') || file.endsWith('.spec.ts')) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

const testFiles = walkDir(TESTS_DIR);
console.log(`Scanning ${testFiles.length} files for ALL type/interface definitions...`);

const allDefinitions = [];

for (const file of testFiles) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  const relativePath = path.relative(WORKSPACE_DIR, file);

  let inInterface = false;
  let currentInterfaceName = '';
  let currentInterfaceLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;

    const interfaceMatch = line.match(/^\s*(?:export\s+)?interface\s+(\w+)/);
    const typeMatch = line.match(/^\s*(?:export\s+)?type\s+(\w+)\s*=/);

    if (interfaceMatch) {
      inInterface = true;
      currentInterfaceName = interfaceMatch[1];
      currentInterfaceLines = [line.trim()];
    } else if (inInterface) {
      currentInterfaceLines.push(line.trim());
      if (line.includes('}')) {
        inInterface = false;
        allDefinitions.push({
          file: relativePath,
          line: lineNumber - currentInterfaceLines.length + 1,
          type: 'interface',
          name: currentInterfaceName,
          content: currentInterfaceLines.join('\n')
        });
      }
    }

    if (typeMatch) {
      allDefinitions.push({
        file: relativePath,
        line: lineNumber,
        type: 'type',
        name: typeMatch[1],
        content: line.trim()
      });
    }
  }
}

console.log(`Found ${allDefinitions.length} definitions:`);
allDefinitions.forEach(d => {
  console.log(`\nFile: ${d.file}:${d.line} (${d.type} ${d.name})`);
  console.log(d.content);
});
