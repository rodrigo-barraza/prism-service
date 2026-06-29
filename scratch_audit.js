import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const FORBIDDEN_WORDS = new Set([
  'err', 'msg', 'req', 'res', 'cb', 'fn', 'evt', 'el', 'btn', 'ctx', 'cfg', 'val', 'tmp', 'idx', 'cnt', 'len', 'num', 'str', 'arr', 'obj', 'src', 'dst', 'prev', 'cur',
  'fc', 'ws', 'col', 'mem', 'mod', 'lim', 'pct', 'bpw', 'qs', 'ct', 'ss', 'cid', 'rel', 're', 'tc', 'ev', 'errMsg', 'wsUrl', 'maxCtx', 'curBlocks'
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
      let current = node;
      while (current) {
        if (ts.isCatchClause(current)) {
          return null;
        }
        if (ts.isParameter(current) && ts.isArrowFunction(current.parent)) {
          const sourceFile = current.getSourceFile();
          const start = current.parent.getStart();
          const end = current.parent.getEnd();
          const text = sourceFile.text.substring(start, end);
          if (!text.includes('\n')) {
            return null;
          }
        }
        current = current.parent;
      }
      return 'Single-letter variable "e" is not allowed outside catch blocks or inline single-line event handlers';
    }
    return `Single-letter variable "${name}" is not allowed`;
  }

  // Check for forbidden abbreviations
  const parts = splitCamelCase(name);
  for (const part of parts) {
    if (FORBIDDEN_WORDS.has(part)) {
      if ((part === 'req' || part === 'res') && ts.isParameter(node.parent)) {
        if (name === 'req' || name === 'res' || name === '_req' || name === '_res') {
          return null;
        }
      }
      return `Variable name "${name}" contains forbidden abbreviation "${part}"`;
    }
  }

  // Check booleans (active -> isActive, loading -> isLoading, done -> isDone)
  const lowercase = name.toLowerCase();
  if (
    lowercase === 'active' || lowercase === 'loading' || lowercase === 'done' ||
    lowercase.endsWith('active') || lowercase.endsWith('loading') || lowercase.endsWith('done')
  ) {
    if (
      !name.startsWith('is') && !name.startsWith('has') && 
      !name.startsWith('should') && !name.startsWith('can') &&
      !name.startsWith('active') && !name.startsWith('loading') && !name.startsWith('done')
    ) {
    } else if (name === 'active' || name === 'loading' || name === 'done') {
      return `Boolean or state variable "${name}" must read as an assertion (e.g. isActive, isLoading, isDone)`;
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

  const lines = code.split('\n');
  lines.forEach((line, index) => {
    if (line.includes('@ts-ignore') || line.includes('@ts-expect-error')) {
      violations.push({
        file: filePath,
        line: index + 1,
        name: '@ts-suppression',
        type: 'comment',
        error: 'TypeScript suppression directive found'
      });
    }
  });

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

    if (ts.isAsExpression(node)) {
      if (node.type.kind === ts.SyntaxKind.AnyKeyword) {
        const { line } = getLineAndChar(node.getStart());
        violations.push({
          file: filePath,
          line,
          name: 'as any',
          type: 'cast',
          error: 'Avoid using "as any" type-safety escape'
        });
      }
    }

    if (ts.isParameter(node) && node.type && node.type.kind === ts.SyntaxKind.UnknownKeyword) {
      const { line } = getLineAndChar(node.getStart());
      violations.push({
        file: filePath,
        line,
        name: node.name.getText(),
        type: 'parameter-unknown',
        error: 'Parameter typed as unknown'
      });
    }

    if (ts.isAsExpression(node) && node.type.getText() === 'Error' && node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.name.text === 'message') {
      const { line } = getLineAndChar(node.getStart());
      violations.push({
        file: filePath,
        line,
        name: 'error as Error',
        type: 'error-cast',
        error: 'Use getErrorMessage(error) instead of (error as Error).message'
      });
    }

    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      if (node.type) {
        const typeText = node.type.getText();
        if (typeText.includes('Record<string, any>') || typeText.includes('Record<string, unknown>')) {
          const { line } = getLineAndChar(node.name ? node.name.getStart() : node.getStart());
          violations.push({
            file: filePath,
            line,
            name: node.name ? node.name.getText() : 'anonymous',
            type: 'return-type',
            error: `Avoid using Record<string, any/unknown> as return type. Use custom Transformed[Entity] interface.`
          });
        }
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
      if (file !== 'node_modules' && file !== 'dist' && file !== 'build' && file !== '__tests__') {
        walkDir(fullPath);
      }
    } else if (file.endsWith('.ts') || file.endsWith('.tsx')) {
      analyzeFile(fullPath);
    }
  }
}

const dir = './src';
walkDir(dir);

fs.writeFileSync('./violations_out.json', JSON.stringify(violations, null, 2));
