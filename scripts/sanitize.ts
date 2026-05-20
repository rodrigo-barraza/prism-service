import { Project, SyntaxKind, VariableDeclarationList } from "ts-morph";

const project = new Project({
  tsConfigFilePath: "tsconfig.json",
});

// Remove all @ts-ignore comments
const sourceFiles = project.getSourceFiles();

for (const sourceFile of sourceFiles) {
  let fileChanged = false;

  // 1. Remove @ts-ignore comments
  const comments = sourceFile.getStatementsWithComments().flatMap(s => {
      // It's easier to just do string replacement for this since comments in ts-morph
      // are tied to nodes and can be tricky to remove without messing up formatting.
      return [];
  });
  
  // We'll just do a regex replace on the file text for @ts-ignore
  const fullText = sourceFile.getFullText();
  if (fullText.includes("@ts-ignore")) {
    const newText = fullText.replace(/\/\/\s*@ts-ignore[^\n]*\n/g, "");
    sourceFile.replaceWithText(newText);
    fileChanged = true;
  }

  // 2. Fix variable declarations like `const pipeline = [` or `const preMatch = {`
  const varDecls = sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
  for (const varDecl of varDecls) {
    const name = varDecl.getName();
    if (name === "pipeline" || name === "reqPipeline" || name === "pipeline" || name.toLowerCase().includes("pipeline")) {
      if (!varDecl.getTypeNode()) {
        const init = varDecl.getInitializer();
        if (init && init.getKind() === SyntaxKind.ArrayLiteralExpression) {
          varDecl.setType("Record<string, any>[]");
          fileChanged = true;
        }
      }
    }
    if (name === "preMatch" || name === "reqMatch" || name === "match" || name.toLowerCase().includes("match")) {
      if (!varDecl.getTypeNode()) {
        const init = varDecl.getInitializer();
        if (init && init.getKind() === SyntaxKind.ObjectLiteralExpression) {
          varDecl.setType("Record<string, any>");
          fileChanged = true;
        }
      }
    }
  }

  if (fileChanged) {
    sourceFile.saveSync();
    console.log(`Updated ${sourceFile.getBaseName()}`);
  }
}
