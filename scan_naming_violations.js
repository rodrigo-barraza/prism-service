import ts from 'typescript';
import fs from 'fs';
import path from 'path';

const FORBIDDEN_WORDS = new Set([
  'err', 'msg', 'req', 'res', 'cb', 'fn', 'evt', 'el', 'btn', 'ctx', 'cfg', 'val', 'tmp', 'idx', 'cnt', 'len', 'num', 'str', 'arr', 'obj', 'src', 'dst', 'prev', 'cur',
  'fc', 'ws', 'col', 'mem', 'mod', 'lim', 'pct', 'bpw', 'qs', 'ct', 'ss', 'cid', 'rel', 're', 'tc', 'ev'
]);

const ALLOWED_SINGLE_LETTERS = new Set([
  'i', 'j', 'k', 'x', 'y', 'z', 'r', 'g', 'b', 'h', 's', 'l', '_'
]);

function splitCamelCase(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-zA-Z0-9]+/);
}

function checkIdentifier(name, node) {
  if (!name) return null;
  
  if (name.length === 1) {
    if (ALLOWED_SINGLE_LETTERS.has(name)) {
      return null; 
    }
    if (name === 'e') {
      // Allow catch clause or parameter of inline arrow function
      let current = node;
      while (current) {
        if (ts.isCatchClause(current)) {
          return null;
        }
        if (ts.isParameter(current) && ts.isArrowFunction(current.parent)) {
          return null;
        }
        current = current.parent;
      }
      return 'Single-letter variable "e" is not allowed outside catch blocks or inline event handlers';
    }
    return `Single-letter variable "${name}" is not allowed`;
  }

  // Check for forbidden abbreviations
  const parts = splitCamelCase(name);
  for (const part of parts) {
    if (FORBIDDEN_WORDS.has(part)) {
      // Express middleware parameters req, res, _req, _res are acceptable as parameters.
      if ((part === 'req' || part === 'res') && ts.isParameter(node.parent)) {
        if (name === 'req' || name === 'res' || name === '_req' || name === '_res') {
          return null;
        }
      }
      return `Variable name "${name}" contains forbidden abbreviation "${part}"`;
    }
  }
  return null;
}

const violations = [];

function analyzeFile(filePath) {
  const code = fs.readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    filePath,
    code,
    ts.ScriptTarget.Latest,
    true
  );

  function getLineAndChar(pos) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(pos);
    return { line: line + 1, character: character + 1 };
  }

  function visit(node) {
    let nameNode = null;
    let type = '';

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      nameNode = node.name;
      type = 'variable';
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      nameNode = node.name;
      type = 'parameter';
    } else if (ts.isFunctionDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      nameNode = node.name;
      type = 'function';
    } else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      nameNode = node.name;
      type = 'method';
    } else if (ts.isPropertyDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      nameNode = node.name;
      type = 'property';
    } else if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      nameNode = node.name;
      type = 'binding';
    }

    if (nameNode) {
      const name = nameNode.text;
      const error = checkIdentifier(name, nameNode);
      if (error) {
        const { line } = getLineAndChar(nameNode.getStart());
        violations.push({
          file: filePath,
          line,
          name,
          type,
          error
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

function walkDir(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      if (file !== 'node_modules' && file !== 'dist' && file !== 'build') {
        walkDir(fullPath);
      }
    } else if (file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.js') || file.endsWith('.jsx')) {
      analyzeFile(fullPath);
    }
  }
}

const targetDirs = [
  '/home/rodrigo/development/prism-service/src',
  '/home/rodrigo/development/tools-service/src'
];

for (const dir of targetDirs) {
  if (fs.existsSync(dir)) {
    console.log(`Scanning directory: ${dir}`);
    walkDir(dir);
  }
}

console.log(`Found ${violations.length} naming violations.`);
fs.writeFileSync('/home/rodrigo/development/all_violations.json', JSON.stringify(violations, null, 2));
console.log('Results written to /home/rodrigo/development/all_violations.json');
