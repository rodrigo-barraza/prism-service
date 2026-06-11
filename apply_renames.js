import { Project, SyntaxKind } from 'ts-morph';
import fs from 'fs';
import path from 'path';

const renames = JSON.parse(fs.readFileSync('/home/rodrigo/development/suggested_renames.json', 'utf8'));
const project = new Project();

console.log(`Starting rename application for ${renames.length} items...`);

// Group by file
const fileMap = new Map();
for (const r of renames) {
  if (!fileMap.has(r.file)) {
    fileMap.set(r.file, []);
  }
  fileMap.get(r.file).push(r);
}

let successCount = 0;
let failCount = 0;

for (const [filePath, fileRenames] of fileMap.entries()) {
  try {
    const sourceFile = project.addSourceFileAtPath(filePath);
    console.log(`\nProcessing file: ${path.basename(filePath)}`);

    // Sort descending by line number to keep line numbers of earlier lines unchanged during modifications
    fileRenames.sort((a, b) => b.line - a.line);

    for (const r of fileRenames) {
      if (r.oldName === r.newName) {
        console.log(`Skipping unchanged rename at line ${r.line}: ${r.oldName} -> ${r.newName}`);
        continue;
      }

      const descNodes = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier);
      const matchingNode = descNodes.find(node => {
        const startLine = node.getStartLineNumber();
        return startLine === r.line && node.getText() === r.oldName;
      });

      if (matchingNode) {
        try {
          matchingNode.rename(r.newName);
          console.log(`  Renamed at line ${r.line}: ${r.oldName} -> ${r.newName}`);
          successCount++;
        } catch (renameError) {
          console.error(`  Failed to rename at line ${r.line} (${r.oldName} -> ${r.newName}):`, renameError.message);
          failCount++;
        }
      } else {
        console.warn(`  Node not found at line ${r.line} for ${r.oldName}`);
        failCount++;
      }
    }

    // Save changes to disk
    await sourceFile.save();
  } catch (fileError) {
    console.error(`Error processing file ${filePath}:`, fileError.message);
  }
}

console.log(`\nRename process finished. Success: ${successCount}, Failures: ${failCount}`);
