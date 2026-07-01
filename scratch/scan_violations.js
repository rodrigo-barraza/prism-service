import fs from 'fs';
import path from 'path';

const SRC_DIR = './src';
const VIOLATIONS_LOG = './violations_out.json';

const ABBREVIATIONS = [
  'req', 'res', 'err', 'idx', 'cnt', 'msg', 'cfg', 'val', 'tmp', 'ctx', 'btn', 'el', 'prev', 'cur', 'num', 'str', 'arr', 'obj', 'src', 'dst'
];

// Refined regexes to avoid false positives in variable names/comments
const TECHNICAL_ANY_REGEX = /:\s*any\b|as\s+any\b|<\s*any\s*>|any\[\]|any\s*>/;
const RECORD_ANY_REGEX = /Record\s*<\s*string\s*,\s*(any|unknown)\s*>/;

function scanFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const violations = [];

  lines.forEach((line, index) => {
    // Skip comments
    if (line.trim().startsWith('//') || line.trim().startsWith('*') || line.trim().startsWith('/*')) return;

    // Check for abbreviations (whole word, camelCase or snake_case)
    ABBREVIATIONS.forEach(abbr => {
      // Avoid matching in strings
      const noStringsLine = line.replace(/(["'])(?:(?=(\\?))\2.)*?\1/g, '""');
      const regex = new RegExp(`\\b${abbr}\\b`, 'i');
      if (regex.test(noStringsLine)) {
        violations.push({
          type: 'ABBREVIATION',
          file: filePath,
          line: index + 1,
          content: line.trim(),
          match: abbr
        });
      }
    });

    // Check for technical any
    if (TECHNICAL_ANY_REGEX.test(line)) {
      violations.push({
        type: 'ANY',
        file: filePath,
        line: index + 1,
        content: line.trim(),
        match: line.match(TECHNICAL_ANY_REGEX)[0]
      });
    }

    // Check for Record any/unknown
    if (RECORD_ANY_REGEX.test(line)) {
      violations.push({
        type: 'RECORD',
        file: filePath,
        line: index + 1,
        content: line.trim(),
        match: line.match(RECORD_ANY_REGEX)[0]
      });
    }
  });

  return violations;
}

function walkDir(dir, callback) {
  fs.readdirSync(dir).forEach(f => {
    let dirPath = path.join(dir, f);
    let isDirectory = fs.statSync(dirPath).isDirectory();
    isDirectory ? walkDir(dirPath, callback) : callback(path.join(dir, f));
  });
}

const allViolations = [];
walkDir(SRC_DIR, (filePath) => {
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
    allViolations.push(...scanFile(filePath));
  }
});

fs.writeFileSync(VIOLATIONS_LOG, JSON.stringify(allViolations, null, 2));
console.log(`Found ${allViolations.length} violations. Saved to ${VIOLATIONS_LOG}`);
