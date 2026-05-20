import { Project, SyntaxKind } from "ts-morph";
import * as fs from "fs";
import * as path from "path";

const project = new Project({ tsConfigFilePath: "tsconfig.json" });

for (const sourceFile of project.getSourceFiles()) {
  let changed = false;

  sourceFile.forEachDescendant(node => {
    if (node.getKind() === SyntaxKind.AnyKeyword) {
      // Find what it's attached to
      const parent = node.getParent();
      if (parent) {
         if (parent.getKind() === SyntaxKind.TypeReference) {
           // Maybe Record<string, any> -> Record<string, unknown>
         }
         // Actually, let's just replace all AnyKeyword with UnknownKeyword
         node.replaceWithText("unknown");
         changed = true;
      }
    }
  });

  if (changed) {
    sourceFile.saveSync();
    console.log(`Updated ${sourceFile.getBaseName()}`);
  }
}
