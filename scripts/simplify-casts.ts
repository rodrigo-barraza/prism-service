import * as fs from "fs";
import * as path from "path";

const SRC_DIR = path.resolve("src");

function walkDir(dir: string, callback: (filePath: string) => void) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      walkDir(filePath, callback);
    } else if (stat.isFile() && (file.endsWith(".ts") || file.endsWith(".tsx"))) {
      callback(filePath);
    }
  }
}

console.log("Starting Cast Simplifier...");

let modifiedFilesCount = 0;
let simplifiedCastsCount = 0;

const regex = /as\s+(unknown|any)\s+as\s+(Record<string,\s*(unknown|any)>|string|number|boolean|\(\([^)]*\)\s*=>\s*[^)]*\)|any\[]|unknown\[]|void|Promise<[^>]*>|string\[]|string\s*\|\s*string\[]|object|Record<string,\s*unknown>\[]|any)/g;

walkDir(SRC_DIR, (filePath) => {
  const originalContent = fs.readFileSync(filePath, "utf-8");
  
  // Replace the bad casts with `as any`
  const newContent = originalContent.replace(regex, "as any");
  
  if (newContent !== originalContent) {
    fs.writeFileSync(filePath, newContent, "utf-8");
    const diff = (originalContent.match(regex) || []).length;
    simplifiedCastsCount += diff;
    modifiedFilesCount++;
    console.log(`Simplified ${diff} casts in ${path.relative(process.cwd(), filePath)}`);
  }
});

console.log(`\nCast Simplifier complete!`);
console.log(`Modified ${modifiedFilesCount} files.`);
console.log(`Simplified ${simplifiedCastsCount} casts.`);
