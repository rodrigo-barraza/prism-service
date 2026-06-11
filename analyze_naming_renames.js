import { Project, SyntaxKind } from 'ts-morph';
import fs from 'fs';
import path from 'path';

const FORBIDDEN_WORDS = {
  err: 'error',
  msg: 'message',
  req: 'request',
  res: 'response',
  cb: 'callback',
  fn: 'function',
  evt: 'event',
  el: 'element',
  btn: 'button',
  ctx: 'context',
  cfg: 'config',
  val: 'value',
  tmp: 'temporary',
  idx: 'index',
  cnt: 'count',
  len: 'length',
  num: 'number',
  str: 'string',
  arr: 'array',
  obj: 'object',
  src: 'source',
  dst: 'destination',
  prev: 'previous',
  cur: 'current',
  fc: 'functionCall',
  ws: 'websocket',
  col: 'collection',
  mem: 'memory',
  mod: 'modal',
  lim: 'limit',
  pct: 'percentage',
  bpw: 'bitsPerWeight',
  qs: 'queryString',
  ct: 'contentType',
  ss: 'streamState',
  cid: 'conversationId',
  rel: 'relativePath',
  re: 'regex',
  tc: 'toolCall',
  ev: 'event'
};

const SINGLE_LETTER_DEFAULT = {
  m: 'message',
  p: 'provider',
  a: 'agent',
  v: 'value',
  t: 'tool',
  n: 'node',
  c: 'client',
  s: 'session',
  w: 'workflow',
  d: 'data'
};

function splitCamelCase(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/);
}

function getSingularName(plural) {
  if (!plural || plural.length <= 1) return null;
  if (plural.endsWith('ies')) return plural.slice(0, -3) + 'y';
  if (plural.endsWith('s')) {
    // Check if ends with 'ss', e.g. class
    if (plural.endsWith('ss')) return plural;
    return plural.slice(0, -1);
  }
  return plural;
}

function suggestSingleLetterRename(name, identifierNode) {
  // 1. Try to check type text if available
  try {
    const type = identifierNode.getType();
    const typeText = type.getText(identifierNode);
    if (typeText && typeText !== 'any' && typeText !== 'unknown') {
      // Clean up generic/array types
      let cleanType = typeText.replace(/\[\]$/, '').split('<')[0].split('.').pop();
      if (cleanType && cleanType.length > 2 && /^[A-Z][A-Za-z0-9_]*$/.test(cleanType)) {
        return cleanType[0].toLowerCase() + cleanType.slice(1);
      }
    }
  } catch (e) {
    // Ignore type check errors
  }

  // 2. Try to trace back map/find caller name
  let parent = identifierNode.getParent();
  while (parent) {
    if (parent.isKind(SyntaxKind.Parameter)) {
      const parentFunc = parent.getParent();
      if (parentFunc && (parentFunc.isKind(SyntaxKind.ArrowFunction) || parentFunc.isKind(SyntaxKind.FunctionExpression))) {
        const caller = parentFunc.getParent();
        if (caller && caller.isKind(SyntaxKind.CallExpression)) {
          const propAccess = caller.getExpression();
          if (propAccess && propAccess.isKind(SyntaxKind.PropertyAccessExpression)) {
            const baseExpr = propAccess.getExpression();
            const callerText = baseExpr.getText().split('.').pop();
            const singular = getSingularName(callerText);
            if (singular && singular !== callerText) {
              return singular;
            }
          }
        }
      }
    }
    parent = parent.getParent();
  }

  // 3. Fallback to default letter mapping
  return SINGLE_LETTER_DEFAULT[name.toLowerCase()] || 'value';
}

function suggestNewName(oldName, identifierNode) {
  const isAllUppercase = oldName === oldName.toUpperCase() && oldName.includes('_');
  if (isAllUppercase) {
    const parts = oldName.split('_');
    const newParts = parts.map(part => {
      const lower = part.toLowerCase();
      if (FORBIDDEN_WORDS[lower]) {
        return FORBIDDEN_WORDS[lower].toUpperCase();
      }
      return part;
    });
    return newParts.join('_');
  }

  if (oldName.length === 1) {
    const rename = suggestSingleLetterRename(oldName, identifierNode);
    // Preserve case if uppercase (unlikely for 1-letter, but safe)
    if (oldName === oldName.toUpperCase()) {
      return rename.toUpperCase();
    }
    return rename;
  }

  const parts = splitCamelCase(oldName);
  const newParts = parts.map((part, index) => {
    const lower = part.toLowerCase();
    let replacement = FORBIDDEN_WORDS[lower];
    if (replacement) {
      if (part === part.toUpperCase()) {
        replacement = replacement.toUpperCase();
      } else if (part[0] === part[0].toUpperCase()) {
        replacement = replacement[0].toUpperCase() + replacement.slice(1);
      }
      return replacement;
    }
    return part;
  });

  return newParts.join('');
}

const violations = JSON.parse(fs.readFileSync('/home/rodrigo/development/all_violations.json', 'utf8'));
const project = new Project();

console.log(`Analyzing ${violations.length} violations...`);

const suggestedRenames = [];

// Group violations by file to avoid loading file multiple times
const fileMap = new Map();
for (const v of violations) {
  if (!fileMap.has(v.file)) {
    fileMap.set(v.file, []);
  }
  fileMap.get(v.file).push(v);
}

for (const [filePath, fileViolations] of fileMap.entries()) {
  try {
    const sourceFile = project.addSourceFileAtPath(filePath);
    console.log(`Analyzing file: ${path.basename(filePath)}`);
    
    for (const v of fileViolations) {
      // Find the node representing the identifier
      const descNodes = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier);
      const matchingNode = descNodes.find(node => {
        const startLine = node.getStartLineNumber();
        return startLine === v.line && node.getText() === v.name;
      });

      if (matchingNode) {
        const newName = suggestNewName(v.name, matchingNode);
        suggestedRenames.push({
          file: v.file,
          line: v.line,
          oldName: v.name,
          newName,
          type: v.type,
          error: v.error
        });
      } else {
        // Fallback if node not found
        suggestedRenames.push({
          file: v.file,
          line: v.line,
          oldName: v.name,
          newName: suggestNewName(v.name, null),
          type: v.type,
          error: v.error + " (Node not matched)"
        });
      }
    }
  } catch (e) {
    console.error(`Error analyzing file ${filePath}:`, e.message);
  }
}

fs.writeFileSync('/home/rodrigo/development/suggested_renames.json', JSON.stringify(suggestedRenames, null, 2));
console.log(`Analysis complete. Suggested renames written to /home/rodrigo/development/suggested_renames.json`);
