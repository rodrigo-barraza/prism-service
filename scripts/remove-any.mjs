import { Project, SyntaxKind } from "ts-morph";
import path from "path";
import fs from "fs";

const project = new Project({
  tsConfigFilePath: "tsconfig.json",
});

const sourceFiles = project.getSourceFiles("src/providers/**/*.ts");

for (const sourceFile of sourceFiles) {
  let modified = false;

  // Add imports if needed
  const hasProviderOptions = sourceFile.getImportDeclaration(dec => dec.getNamedImports().some(n => n.getName() === "ProviderOptions"));
  
  // We'll just do text replacements for specific patterns to be safe and accurate, 
  // since AST replacement of specific keywords can be tricky with formatting.
  let text = sourceFile.getFullText();

  // Parameter specific replacements
  text = text.replace(/\(messages:\s*any\)/g, "(messages: ChatMessage[])");
  text = text.replace(/\(messages:\s*any\[\]\)/g, "(messages: ChatMessage[])");
  text = text.replace(/messages:\s*any,/g, "messages: ChatMessage[],");
  text = text.replace(/options:\s*any\s*=\s*{}/g, "options: ProviderOptions = {}");
  text = text.replace(/options:\s*any/g, "options: ProviderOptions");
  text = text.replace(/model:\s*any\s*=/g, "model: string =");
  text = text.replace(/baseUrl:\s*any/g, "baseUrl: string");
  text = text.replace(/instanceId:\s*any/g, "instanceId: string");
  text = text.replace(/prompt:\s*any\s*=/g, "prompt: string =");
  text = text.replace(/systemPrompt:\s*any/g, "systemPrompt?: string");
  text = text.replace(/images:\s*any,/g, "images: string[],");
  text = text.replace(/catch\s*\(\s*error:\s*any\s*\)/g, "catch (error: unknown)");
  text = text.replace(/catch\s*\(\s*([a-zA-Z0-9_]+):\s*any\s*\)/g, "catch ($1: unknown)");
  text = text.replace(/\(error:\s*any/g, "(error: unknown");
  
  // Specific internal replacements
  text = text.replace(/contentBlocks:\s*any\[\]/g, "contentBlocks: Record<string, unknown>[]");
  text = text.replace(/tools:\s*any\[\]/g, "tools: Record<string, unknown>[]");
  text = text.replace(/const\s+lines:\s*any\[\]/g, "const lines: string[]");
  text = text.replace(/const\s+parts:\s*any\[\]/g, "const parts: Record<string, unknown>[]");
  text = text.replace(/const\s+messages:\s*any\[\]/g, "const messages: ChatMessage[]");
  
  // Generic map/filter/find callbacks
  text = text.replace(/\(m:\s*any\)/g, "(m: ChatMessage)");
  text = text.replace(/\(c:\s*any\)/g, "(c: Record<string, unknown>)");
  text = text.replace(/\(p:\s*any\)/g, "(p: Record<string, unknown>)");
  text = text.replace(/\(t:\s*any\)/g, "(t: Record<string, unknown>)");
  text = text.replace(/\(image:\s*any\)/g, "(image: string)");
  text = text.replace(/\(dataUrl:\s*any\)/g, "(dataUrl: string)");
  
  // Fallback for remaining explicit `: any`
  // careful not to break generic <any> yet
  text = text.replace(/:\s*any\[\]/g, ": Record<string, unknown>[]");
  text = text.replace(/:\s*any\b/g, ": Record<string, unknown>");
  text = text.replace(/<\s*any\s*>/g, "<Record<string, unknown>>");

  // Ensure imports are present
  if (text.includes("ChatMessage") || text.includes("ProviderOptions")) {
    if (!text.includes("import { ProviderOptions")) {
      const importStmt = `import { ProviderOptions, ChatMessage } from "../types/ProviderTypes.ts";\n`;
      text = importStmt + text;
    }
  }

  if (sourceFile.getFullText() !== text) {
    fs.writeFileSync(sourceFile.getFilePath(), text);
    console.log(`Updated ${sourceFile.getFilePath()}`);
  }
}
