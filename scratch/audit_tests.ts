import { Project, SyntaxKind, InterfaceDeclaration, TypeAliasDeclaration, ObjectLiteralExpression, PropertyAssignment, CallExpression } from "ts-morph";
import * as fs from "fs";
import * as path from "path";

// Initialize project
const project = new Project({
  tsConfigFilePath: "tsconfig.json",
  skipAddingFilesFromTsConfig: true,
});

// Load production source files and test files
console.log("Loading files...");
project.addSourceFilesAtPaths([
  "src/**/*.ts",
  "tests/**/*.ts"
]);

const prodFiles = project.getSourceFiles().filter(f => !f.getFilePath().includes("/tests/"));
const testFiles = project.getSourceFiles().filter(f => f.getFilePath().includes("/tests/"));

console.log(`Loaded ${prodFiles.length} production files and ${testFiles.length} test files.`);

// 1. Gather all production exported types/interfaces and their properties
interface TypeInfo {
  name: string;
  filePath: string;
  properties: string[];
  isEnum: boolean;
  isConst: boolean;
}

const prodTypes = new Map<string, TypeInfo>();

for (const sourceFile of prodFiles) {
  const filePath = sourceFile.getFilePath();

  // Interfaces
  for (const intf of sourceFile.getInterfaces()) {
    if (intf.isExported()) {
      const name = intf.getName();
      const properties = intf.getProperties().map(p => p.getName());
      prodTypes.set(name, { name, filePath, properties, isEnum: false, isConst: false });
    }
  }

  // Type aliases
  for (const ta of sourceFile.getTypeAliases()) {
    if (ta.isExported()) {
      const name = ta.getName();
      // Try to get property names if it's an object/intersection type
      const properties: string[] = [];
      const typeNode = ta.getTypeNode();
      if (typeNode) {
        typeNode.forEachDescendant(desc => {
          if (desc.getKind() === SyntaxKind.PropertySignature) {
            properties.push((desc as any).getName());
          }
        });
      }
      prodTypes.set(name, { name, filePath, properties, isEnum: false, isConst: false });
    }
  }

  // Enums
  for (const en of sourceFile.getEnums()) {
    if (en.isExported()) {
      const name = en.getName();
      const properties = en.getMembers().map(m => m.getName());
      prodTypes.set(name, { name, filePath, properties, isEnum: true, isConst: false });
    }
  }

  // Exported constants
  for (const vd of sourceFile.getVariableDeclarations()) {
    if (vd.isExported()) {
      const name = vd.getName();
      prodTypes.set(name, { name, filePath, properties: [], isEnum: false, isConst: true });
    }
  }
}

console.log(`Gathered ${prodTypes.size} exported production types/constants.`);

// Gather constants and enums from constants.ts specifically for Category 2 checking
const constantsFile = project.getSourceFile("src/constants.ts");
const constantValues = new Map<string, { varName: string; keyName?: string }>();
if (constantsFile) {
  for (const vd of constantsFile.getVariableDeclarations()) {
    const init = vd.getInitializer();
    if (init && init.getKind() === SyntaxKind.ObjectLiteralExpression) {
      const obj = init as ObjectLiteralExpression;
      for (const prop of obj.getProperties()) {
        if (prop.getKind() === SyntaxKind.PropertyAssignment) {
          const pa = prop as PropertyAssignment;
          const key = pa.getName();
          const valInit = pa.getInitializer();
          if (valInit && valInit.getKind() === SyntaxKind.StringLiteral) {
            const val = (valInit as any).getLiteralValue();
            constantValues.set(val, { varName: vd.getName(), keyName: key });
          }
        }
      }
    } else if (init && init.getKind() === SyntaxKind.StringLiteral) {
      const val = (init as any).getLiteralValue();
      constantValues.set(val, { varName: vd.getName() });
    }
  }
}

console.log(`Gathered ${constantValues.size} constants values from constants.ts.`);

// Findings repository
interface Finding {
  category: string;
  file: string;
  lineRange: string;
  severity: "🔴" | "🟡" | "🔵";
  sourceOfTruth: string;
  description: string;
  fix: string;
}

const findings: Finding[] = [];

// Audit test files
for (const testFile of testFiles) {
  const relativeTestPath = path.relative("/home/rodrigo/development/prism-service", testFile.getFilePath());

  // Category 1: Duplicated Types & Interfaces
  // Local interfaces/type aliases declared inside tests
  for (const intf of testFile.getInterfaces()) {
    const name = intf.getName();
    // Skip legitimate test-only types
    if (name.includes("Mock") || name.includes("Test") || name.endsWith("Record") || name.endsWith("Helper")) {
      continue;
    }
    const match = prodTypes.get(name);
    if (match) {
      const startLine = intf.getStartLineNumber();
      const endLine = intf.getEndLineNumber();
      const testProps = intf.getProperties().map(p => p.getName());
      const prodProps = match.properties;

      // Field diff
      const both = testProps.filter(p => prodProps.includes(p));
      const testOnly = testProps.filter(p => !prodProps.includes(p));
      const prodOnly = prodProps.filter(p => !testProps.includes(p));

      let diffDesc = both.map(p => `✓ ${p}`).join(", ") + "\n";
      if (testOnly.length > 0) diffDesc += `⚠️ drift: ${testOnly.join(", ")}\n`;
      if (prodOnly.length > 0) diffDesc += `🔴 blind spot: ${prodOnly.join(", ")}`;

      findings.push({
        category: "Duplicated Types & Interfaces (Phantom Contracts)",
        file: relativeTestPath,
        lineRange: `${startLine}–${endLine}`,
        severity: "🔴",
        sourceOfTruth: `${path.relative("/home/rodrigo/development/prism-service", match.filePath)} → ${name}`,
        description: `Test file declares local interface '${name}' instead of importing it from production.\nDiff:\n${diffDesc}`,
        fix: `Import { ${name} } from '${path.relative(path.dirname(testFile.getFilePath()), match.filePath).replace(/\.ts$/, "")}' and remove local declaration.`,
      });
    }
  }

  for (const ta of testFile.getTypeAliases()) {
    const name = ta.getName();
    if (name.includes("Mock") || name.includes("Test")) continue;
    const match = prodTypes.get(name);
    if (match) {
      const startLine = ta.getStartLineNumber();
      const endLine = ta.getEndLineNumber();
      findings.push({
        category: "Duplicated Types & Interfaces (Phantom Contracts)",
        file: relativeTestPath,
        lineRange: `${startLine}–${endLine}`,
        severity: "🔴",
        sourceOfTruth: `${path.relative("/home/rodrigo/development/prism-service", match.filePath)} → ${name}`,
        description: `Test file declares local type '${name}' instead of importing it from production.`,
        fix: `Import { ${name} } from '${path.relative(path.dirname(testFile.getFilePath()), match.filePath).replace(/\.ts$/, "")}' and remove local declaration.`,
      });
    }
  }

  // Category 2: Hard-Coded Magic Strings & Values
  testFile.forEachDescendant(node => {
    if (node.getKind() === SyntaxKind.StringLiteral) {
      const val = (node as any).getLiteralValue();
      const match = constantValues.get(val);
      if (match) {
        // Exclude test assertions that verify constants output, but check if we're using a literal where the constant is defined
        // If the file does NOT import the constant, flag it
        const imports = testFile.getImportDeclarations();
        const importsConstant = imports.some(imp => {
          const named = imp.getNamedImports().map(ni => ni.getName());
          return named.includes(match.varName);
        });

        if (!importsConstant && !relativeTestPath.includes("setup.ts")) {
          const line = node.getStartLineNumber();
          const constRef = match.keyName ? `${match.varName}.${match.keyName}` : match.varName;
          findings.push({
            category: "Hard-Coded Magic Strings & Values",
            file: relativeTestPath,
            lineRange: `${line}`,
            severity: "🟡",
            sourceOfTruth: `src/constants.ts → ${constRef}`,
            description: `Hardcoded magic string "${val}" duplicates production constant '${constRef}'.`,
            fix: `Import { ${match.varName} } from '../src/constants.ts' and replace "${val}" with ${constRef}.`,
          });
        }
      }
    }
  });

  // Category 3: Reimplemented Production Logic
  // Look for test helper functions that duplicate utility logic
  for (const fn of testFile.getFunctions()) {
    const text = fn.getText();
    if (text.includes("Copied from") || text.includes("Replicates") || text.includes("replicates")) {
      findings.push({
        category: "Reimplemented Production Logic",
        file: relativeTestPath,
        lineRange: `${fn.getStartLineNumber()}–${fn.getEndLineNumber()}`,
        severity: "🔴",
        sourceOfTruth: `Check referenced comments`,
        description: `Test helper function explicit comment admits duplicating production logic.`,
        fix: `Import and call the production function directly.`,
      });
    }
  }

  // Category 4: Stale Mock Contracts
  // Look for vi.mock calls, spy setups, or mock objects where return types or properties might be stale.
  testFile.forEachDescendant(node => {
    if (node.getKind() === SyntaxKind.CallExpression) {
      const call = node as CallExpression;
      const expression = call.getExpression();
      if (expression.getText().includes("vi.spyOn") || expression.getText().includes("vi.mock")) {
        // Check if mocking/spying on non-existent methods
        const args = call.getArguments();
        if (args.length >= 2 && args[0].getKind() === SyntaxKind.Identifier && args[1].getKind() === SyntaxKind.StringLiteral) {
          const objName = args[0].getText();
          const methodName = (args[1] as any).getLiteralValue();
          
          // Let's find the object in prodTypes or general exports
          const match = prodTypes.get(objName);
          if (match && match.properties.length > 0 && !match.properties.includes(methodName) && !match.isEnum) {
            findings.push({
              category: "Stale Mock Contracts",
              file: relativeTestPath,
              lineRange: `${call.getStartLineNumber()}`,
              severity: "🔴",
              sourceOfTruth: `${path.relative("/home/rodrigo/development/prism-service", match.filePath)} → ${objName}`,
              description: `Spies or mocks non-existent method '${methodName}' on class/object '${objName}'.`,
              fix: `Update mock to use correct method name from production source.`,
            });
          }
        }
      }
    }
  });
}

// Write findings to JSON and console
fs.writeFileSync("scratch/audit_findings.json", JSON.stringify(findings, null, 2));
console.log(`Found ${findings.length} issues in total.`);
