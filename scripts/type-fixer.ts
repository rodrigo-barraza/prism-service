import { Project, SyntaxKind } from "ts-morph";
import { execSync } from "child_process";
import * as fs from "fs";

const TARGET_DIR = "/home/rodrigo/development/tools-service";

const project = new Project({
  tsConfigFilePath: `${TARGET_DIR}/tsconfig.json`,
});

function compiles() {
  try {
    execSync("npx tsc --noEmit", { cwd: TARGET_DIR, stdio: "ignore" });
    return true;
  } catch (e) {
    return false;
  }
}

console.log("Starting automated strict typing loop on tools-service...");

const sourceFiles = project.getSourceFiles();
for (const sourceFile of sourceFiles) {
  let fileChanged = false;
  
  // Find all AnyKeywords
  const anyNodes = sourceFile.getDescendantsOfKind(SyntaxKind.AnyKeyword);
  if (anyNodes.length === 0) continue;
  
  console.log(`Checking ${sourceFile.getBaseName()} (${anyNodes.length} 'any's)...`);
  
  // We'll try to replace them with unknown
  const originalText = sourceFile.getFullText();
  
  anyNodes.forEach(node => {
     node.replaceWithText("unknown");
  });
  
  sourceFile.saveSync();
  
  if (compiles()) {
     console.log(`  -> Successfully replaced all 'any' with 'unknown'!`);
  } else {
     // Revert
     console.log(`  -> Compilation failed. Reverting...`);
     sourceFile.replaceWithText(originalText);
     sourceFile.saveSync();
  }
}
