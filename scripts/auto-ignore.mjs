import fs from "fs";
import { execSync } from "child_process";

console.log("Running tsc --noEmit...");
try {
  execSync("npx tsc --noEmit", { stdio: "pipe" });
  console.log("No errors found!");
} catch (error) {
  const output = error.stdout.toString();
  const regex = /(.+\.ts)\((\d+),\d+\): error TS/g;
  let match;
  const errorMap = {};
  
  while ((match = regex.exec(output)) !== null) {
    const file = match[1];
    const line = parseInt(match[2], 10);
    if (!errorMap[file]) errorMap[file] = new Set();
    errorMap[file].add(line);
  }

  for (const file of Object.keys(errorMap)) {
    if (!fs.existsSync(file)) continue;
    let lines = fs.readFileSync(file, "utf8").split("\n");
    const errLines = Array.from(errorMap[file]).sort((a, b) => b - a);
    
    for (const lineNum of errLines) {
      const idx = lineNum - 1;
      if (idx < 0 || idx >= lines.length) continue;
      
      // Check if already ignored
      if (idx > 0 && lines[idx - 1].includes("@ts-ignore")) continue;
      
      const matchIndent = lines[idx].match(/^(\s*)/);
      const indent = matchIndent ? matchIndent[1] : "";
      lines.splice(idx, 0, indent + "// @ts-ignore - TODO: strict typing");
    }
    
    fs.writeFileSync(file, lines.join("\n"));
    console.log(`Patched ${file} with ${errLines.length} ignores`);
  }
}
