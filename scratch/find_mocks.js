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
    } else if (file.endsWith('.test.ts') || file.endsWith('.spec.ts') || file.endsWith('setup.ts')) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

const testFiles = walkDir(TESTS_DIR);
if (fs.existsSync(path.join(WORKSPACE_DIR, 'tests/setup.ts'))) {
  testFiles.push(path.join(WORKSPACE_DIR, 'tests/setup.ts'));
}

console.log(`Scanning ${testFiles.length} files for vi.mock calls...`);

for (const file of testFiles) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  const relativePath = path.relative(WORKSPACE_DIR, file);

  let currentMock = null;
  let mockLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;

    if (line.includes('vi.mock(')) {
      currentMock = {
        file: relativePath,
        line: lineNumber,
        match: line.match(/vi\.mock\(['"]([^'"]+)['"]/)[1]
      };
      mockLines = [line.trim()];
    } else if (currentMock) {
      mockLines.push(line.trim());
      if (line.includes('});') || line.includes('})')) {
        console.log(`\nFile: ${currentMock.file}:${currentMock.line} - Mocks module "${currentMock.match}"`);
        console.log(mockLines.slice(0, 15).join('\n') + (mockLines.length > 15 ? '\n... (truncated)' : ''));
        currentMock = null;
        mockLines = [];
      }
    }
  }
}
