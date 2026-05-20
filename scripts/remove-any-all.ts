import { Project, SyntaxKind } from "ts-morph";

const TARGET_DIR = "/home/rodrigo/development/tools-service";

const project = new Project({
  tsConfigFilePath: `${TARGET_DIR}/tsconfig.json`,
});

for (const sourceFile of project.getSourceFiles()) {
  let changed = false;
  
  const anyNodes = sourceFile.getDescendantsOfKind(SyntaxKind.AnyKeyword);
  
  // We'll replace them starting from the end to not mess up offsets
  for (let i = anyNodes.length - 1; i >= 0; i--) {
     const node = anyNodes[i];
     const parent = node.getParent();
     if (parent && parent.getKind() === SyntaxKind.ArrayType) {
         parent.replaceWithText("unknown[]");
         changed = true;
     } else if (parent && parent.getKind() === SyntaxKind.TypeReference) {
         // e.g. Record<string, any>
         node.replaceWithText("unknown");
         changed = true;
     } else {
         // It's a bare 'any'
         // For parameters, if it's (x: any), we replace with (x: unknown) or just remove it?
         // Let's replace with `unknown`
         node.replaceWithText("unknown");
         changed = true;
     }
  }
  
  if (changed) {
    sourceFile.saveSync();
  }
}
