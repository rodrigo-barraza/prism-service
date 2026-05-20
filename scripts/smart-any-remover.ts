import { Project, SyntaxKind, TypeGuards, Node, ParameterDeclaration, VariableDeclaration } from "ts-morph";
import * as fs from "fs";

const TARGET_DIR = "/home/rodrigo/development/tools-service";

const project = new Project({
  tsConfigFilePath: `${TARGET_DIR}/tsconfig.json`,
});

console.log("Starting Smart Any Remover...");

const sourceFiles = project.getSourceFiles();

for (const sourceFile of sourceFiles) {
  const anyNodes = sourceFile.getDescendantsOfKind(SyntaxKind.AnyKeyword);
  if (anyNodes.length === 0) continue;

  console.log(`\nProcessing ${sourceFile.getBaseName()} (${anyNodes.length} anys)...`);
  
  for (let i = anyNodes.length - 1; i >= 0; i--) {
     const currentAnyNodes = sourceFile.getDescendantsOfKind(SyntaxKind.AnyKeyword);
     if (i >= currentAnyNodes.length) continue;
     const node = currentAnyNodes[i];
     
     const parent = node.getParent();
     if (!parent) continue;

     const originalText = sourceFile.getFullText();
     let changed = false;

     if (Node.isArrayTypeNode(parent)) {
       parent.replaceWithText("unknown[]");
       changed = true;
     } else if (Node.isTypeReference(parent) && parent.getText().includes("any")) {
       node.replaceWithText("unknown");
       changed = true;
     } else if (Node.isParameterDeclaration(parent)) {
       parent.removeType();
       changed = true;
     } else if (Node.isVariableDeclaration(parent)) {
       parent.removeType();
       changed = true;
     } else {
       node.replaceWithText("unknown");
       changed = true;
     }

     if (!changed) continue;

     const getFileDiags = () => sourceFile.getPreEmitDiagnostics();
     const diags = getFileDiags();
     
     if (diags.length > 0) {
        let resolved = false;
        
        if (!resolved && (Node.isParameterDeclaration(parent) || Node.isVariableDeclaration(parent))) {
           sourceFile.replaceWithText(originalText);
           const newAnyNodes = sourceFile.getDescendantsOfKind(SyntaxKind.AnyKeyword);
           const newNode = newAnyNodes[i];
           if (newNode) {
             const newParent = newNode.getParent();
             if (Node.isParameterDeclaration(newParent) || Node.isVariableDeclaration(newParent)) {
                newParent.setType("Record<string, unknown>");
                if (getFileDiags().length === 0) {
                   resolved = true;
                }
             }
           }
        }

        if (!resolved) {
           sourceFile.replaceWithText(originalText);
           const newAnyNodes2 = sourceFile.getDescendantsOfKind(SyntaxKind.AnyKeyword);
           const newNode2 = newAnyNodes2[i];
           if (newNode2) {
               newNode2.replaceWithText("unknown");
               const currentDiags = getFileDiags();
               
               let props = new Set<string>();
               for (const d of currentDiags) {
                  const msg = d.getMessageText();
                  const strMsg = typeof msg === "string" ? msg : msg.getMessageText();
                  const match = strMsg.match(/Property '([^']+)' does not exist on type/);
                  if (match) {
                     props.add(match[1]);
                  }
               }
               
               if (props.size > 0) {
                   const propsList = Array.from(props).map(p => `${p}: unknown`).join(", ");
                   sourceFile.replaceWithText(originalText);
                   const newAnyNodes3 = sourceFile.getDescendantsOfKind(SyntaxKind.AnyKeyword);
                   const newNode3 = newAnyNodes3[i];
                   if (newNode3) {
                      const newParent3 = newNode3.getParent();
                      if (Node.isParameterDeclaration(newParent3) || Node.isVariableDeclaration(newParent3)) {
                         newParent3.setType(`{ ${propsList} }`);
                         if (getFileDiags().length === 0) {
                             resolved = true;
                         } else {
                             // Even with the inferred properties it fails, try adding Record<string, unknown>
                             newParent3.setType(`{ ${propsList} } & Record<string, unknown>`);
                             if (getFileDiags().length === 0) {
                                resolved = true;
                             }
                         }
                      }
                   }
               }
           }
        }

        if (!resolved && getFileDiags().length > 0) {
           sourceFile.replaceWithText(originalText);
           console.log(`  -> Failed to resolve node at index ${i}`);
        } else {
           console.log(`  -> Successfully resolved node at index ${i}`);
        }
     } else {
       console.log(`  -> Successfully resolved node at index ${i} (no errors)`);
     }
  }
  sourceFile.saveSync();
}
