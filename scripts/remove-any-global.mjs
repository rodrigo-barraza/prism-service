import fs from "fs";
import path from "path";

function walkDir(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach((file) => {
        file = path.join(dir, file);
        const stat = fs.statSync(file);
        if (stat && stat.isDirectory()) { 
            results = results.concat(walkDir(file));
        } else { 
            if (file.endsWith(".ts")) results.push(file);
        }
    });
    return results;
}

const files = walkDir("src");
let totalReplaced = 0;

for (const file of files) {
  let content = fs.readFileSync(file, "utf8");
  let original = content;

  // Express Route Handlers
  content = content.replace(/\(req:\s*any,\s*res:\s*any,\s*next:\s*any\)/g, "(req: Request, res: Response, next: NextFunction)");
  content = content.replace(/\(req:\s*any,\s*res:\s*any\)/g, "(req: Request, res: Response)");
  content = content.replace(/\(_req:\s*any,\s*res:\s*any,\s*next:\s*any\)/g, "(_req: Request, res: Response, next: NextFunction)");
  content = content.replace(/\(_req:\s*any,\s*res:\s*any\)/g, "(_req: Request, res: Response)");
  
  // Try to be smart about primitive params by their names
  content = content.replace(/name:\s*any\b/g, "name: string");
  content = content.replace(/uri:\s*any\b/g, "uri: string");
  content = content.replace(/dbName:\s*any\b/g, "dbName: string");
  content = content.replace(/collectionName:\s*any\b/g, "collectionName: string");
  content = content.replace(/id:\s*any\b/g, "id: string");
  content = content.replace(/url:\s*any\b/g, "url: string");
  content = content.replace(/query:\s*any\b/g, "query: string");
  content = content.replace(/path:\s*any\b/g, "path: string");
  content = content.replace(/message:\s*any\b/g, "message: string");
  content = content.replace(/role:\s*any\b/g, "role: string");
  content = content.replace(/content:\s*any\b/g, "content: string");

  // Arrays and Objects
  content = content.replace(/:\s*any\[\]/g, ": Record<string, unknown>[]");
  content = content.replace(/<\s*any\s*>/g, "<Record<string, unknown>>");
  
  // Generic fallback for error catching
  content = content.replace(/catch\s*\(\s*error:\s*any\s*\)/g, "catch (error: unknown)");
  content = content.replace(/catch\s*\(\s*([a-zA-Z0-9_]+):\s*any\s*\)/g, "catch ($1: unknown)");
  
  // Fallback for remaining explicit `: any`
  content = content.replace(/:\s*any\b/g, ": Record<string, unknown>");
  content = content.replace(/as\s+any\b/g, "as Record<string, unknown>");

  // Express imports
  if (original.match(/req:\s*any|res:\s*any/) && content.match(/Request|Response|NextFunction/)) {
     if (!content.includes('import { Request')) {
         // handle existing express imports
         if (content.includes('from "express"')) {
             content = content.replace(/from "express"/, ', Request, Response, NextFunction } from "express"');
             content = content.replace(/\{ ,/, "{");
         } else {
             content = `import { Request, Response, NextFunction } from "express";\n` + content;
         }
     }
  }

  if (content !== original) {
    fs.writeFileSync(file, content);
    console.log("Updated", file);
    totalReplaced++;
  }
}

console.log(`Updated ${totalReplaced} files.`);
