import { Project, SyntaxKind } from "ts-morph";
import * as path from "path";

const project = new Project({
  tsConfigFilePath: "tsconfig.json",
});

const constantsFile = project.addSourceFileAtPath("src/constants.ts");
const testFiles = project.addSourceFilesAtPaths("tests/**/*.ts");

// Gather constants mapping from string value -> constant name
// e.g. "openai" -> "PROVIDERS.OPENAI"
const constantMap = new Map<string, { importName: string; accessPath: string }>();

for (const vd of constantsFile.getVariableDeclarations()) {
  const init = vd.getInitializer();
  const varName = vd.getName();
  if (init && init.getKind() === SyntaxKind.ObjectLiteralExpression) {
    const obj = init as any;
    for (const prop of obj.getProperties()) {
      if (prop.getKind() === SyntaxKind.PropertyAssignment) {
        const key = prop.getName();
        const valInit = prop.getInitializer();
        if (valInit && valInit.getKind() === SyntaxKind.StringLiteral) {
          const val = valInit.getLiteralValue();
          constantMap.set(val, { importName: varName, accessPath: `${varName}.${key}` });
        }
      }
    }
  } else if (init && init.getKind() === SyntaxKind.StringLiteral) {
    const val = init.getLiteralValue();
    constantMap.set(val, { importName: varName, accessPath: varName });
  }
}

console.log("Constant map compiled size:", constantMap.size);

// For each test file:
for (const testFile of testFiles) {
  // Skip live tests, as requested to avoid touching production or live test setups unless they are direct unit test alignments
  const isLive = testFile.getFilePath().includes("/live/");
  if (isLive) continue;

  let fileModified = false;
  const neededImports = new Set<string>();

  // Find all string literals
  const stringLiterals = testFile.getDescendantsOfKind(SyntaxKind.StringLiteral);

  for (const literal of stringLiterals) {
    let val: string;
    try {
      val = literal.getLiteralValue();
    } catch {
      continue;
    }
    const match = constantMap.get(val);
    if (!match) continue;

    // Check if literal is inside an import/export declaration or similar
    let parent: any = literal.getParent();
    let shouldSkip = false;
    while (parent) {
      const kind = parent.getKind();
      if (kind === SyntaxKind.ImportDeclaration || 
          kind === SyntaxKind.ExportDeclaration ||
          kind === SyntaxKind.ModuleSpecifier) {
        shouldSkip = true;
        break;
      }
      // Skip if it's vi.mock(...) or similar
      if (kind === SyntaxKind.CallExpression) {
        const expr = parent.getExpression();
        const exprText = expr.getText();
        if (exprText === "vi.mock" || exprText === "vi.unmock" || exprText === "import" || exprText === "require") {
          shouldSkip = true;
          break;
        }
      }
      parent = parent.getParent();
    }

    if (shouldSkip) continue;

    // Replace the literal node with the identifier/access path
    try {
      console.log(`Replacing "${val}" with ${match.accessPath} in ${testFile.getBaseName()}:${literal.getStartLineNumber()}`);
      literal.replaceWithText(match.accessPath);
      neededImports.add(match.importName);
      fileModified = true;
    } catch (e) {
      console.error(`Failed to replace literal in ${testFile.getBaseName()}:`, e);
    }
  }

  if (fileModified && neededImports.size > 0) {
    // Add import statement at the top of the file
    // Relative path from testFile to src/constants.ts
    const testDir = path.dirname(testFile.getFilePath());
    let relativePathToConstants = path.relative(testDir, constantsFile.getFilePath())
      .replace(/\\/g, "/")
      .replace(/\.ts$/, "");
    if (!relativePathToConstants.startsWith(".")) {
      relativePathToConstants = "./" + relativePathToConstants;
    }

    // Check if there is already an import from constants
    const existingImports = testFile.getImportDeclarations();
    let importDecl = existingImports.find(imp => {
      const moduleSpec = imp.getModuleSpecifierValue();
      return moduleSpec === relativePathToConstants || 
             moduleSpec === relativePathToConstants + ".ts" ||
             moduleSpec === relativePathToConstants.replace(".ts", "");
    });

    if (importDecl) {
      const namedImports = importDecl.getNamedImports().map(ni => ni.getName());
      for (const impName of neededImports) {
        if (!namedImports.includes(impName)) {
          importDecl.addNamedImport(impName);
        }
      }
    } else {
      testFile.addImportDeclaration({
        namedImports: Array.from(neededImports),
        moduleSpecifier: relativePathToConstants
      });
    }
    
    try {
      testFile.saveSync();
    } catch (e) {
      console.error(`Failed to save ${testFile.getBaseName()}:`, e);
    }
  }
}

console.log("All replacements applied.");
