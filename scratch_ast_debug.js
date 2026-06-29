import fs from 'fs';
import ts from 'typescript';

const code = fs.readFileSync('./src/services/ToolContext.ts', 'utf8');
const sourceFile = ts.createSourceFile(
  'ToolContext.ts',
  code,
  ts.ScriptTarget.Latest,
  true
);

function visit(node) {
  if (ts.isParameter(node)) {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    console.log(`Parameter name: "${node.name.getText()}" on line ${line + 1}`);
    console.log(`  Type text: "${node.type ? node.type.getText(sourceFile) : 'none'}"`);
    console.log(`  Type kind: ${node.type ? node.type.kind : 'none'} (UnknownKeyword is ${ts.SyntaxKind.UnknownKeyword})`);
  }
  ts.forEachChild(node, visit);
}

visit(sourceFile);
