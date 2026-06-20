import fs from 'fs';
import path from 'path';

const TESTS_DIR = '/home/rodrigo/development/prism-service/tests';

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
console.log(`Found ${testFiles.length} test files to scan.`);

const results = [];

for (const file of testFiles) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  const relativePath = path.relative('/home/rodrigo/development/prism-service', file);

  const interfaces = [];
  const types = [];
  const anyAssertions = [];
  const mocks = [];
  const hardcodedStrings = [];

  // Simple scan
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;

    // Detect interfaces
    const interfaceMatch = line.match(/^\s*interface\s+(\w+)/);
    if (interfaceMatch) {
      interfaces.push({ name: interfaceMatch[1], line: lineNumber, content: line.trim() });
    }

    // Detect types
    const typeMatch = line.match(/^\s*type\s+(\w+)\s*=/);
    if (typeMatch && !typeMatch[1].includes('Test') && !typeMatch[1].includes('Mock')) {
      types.push({ name: typeMatch[1], line: lineNumber, content: line.trim() });
    }

    // Detect 'as any' / 'as unknown'
    if (line.includes('as any') || line.includes('as unknown')) {
      anyAssertions.push({ line: lineNumber, content: line.trim() });
    }

    // Detect vi.mock
    if (line.includes('vi.mock(')) {
      mocks.push({ line: lineNumber, content: line.trim() });
    }

    // Detect prompt delimiters or specific magic strings
    const magicStrings = [
      '\\[System Context\\]',
      '\\[CONTEXT NOTE:',
      '\\[User Message\\]',
      '\\[Project Skills\\]',
      '\\[Agent Memory\\]',
      '\\[Somatic State',
      '\\[Conversation Summary',
      'chain_of_thought',
      'tree_of_thoughts',
      'graph_of_thoughts',
      'tree_of_thought',
      'estimation',
      'vram_benchmarks',
      'somatic_state',
      'requests',
      'model_conversations',
      'agent_conversations',
      'workflows'
    ];

    for (const pattern of magicStrings) {
      const regex = new RegExp(`['"]${pattern}['"]|['"]${pattern}`);
      if (regex.test(line)) {
        hardcodedStrings.push({ pattern, line: lineNumber, content: line.trim() });
      }
    }
  }

  if (interfaces.length > 0 || types.length > 0 || anyAssertions.length > 0 || mocks.length > 0 || hardcodedStrings.length > 0) {
    results.push({
      file: relativePath,
      interfaces,
      types,
      anyAssertions,
      mocks,
      hardcodedStrings
    });
  }
}

fs.writeFileSync('/home/rodrigo/development/prism-service/scratch/audit_raw_results.json', JSON.stringify(results, null, 2));
console.log('Scan completed. Raw audit results written to scratch/audit_raw_results.json.');
