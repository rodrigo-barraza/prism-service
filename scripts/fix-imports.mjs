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
for (const file of files) {
  let content = fs.readFileSync(file, "utf8");
  let original = content;

  content = content.replace(/import express\s*,\s*Request,\s*Response,\s*NextFunction\s*\}\s*from\s*"express";/g, 'import express, { Request, Response, NextFunction } from "express";');
  content = content.replace(/import\s*\{\s*Router\s*\}\s*,\s*Request,\s*Response,\s*NextFunction\s*\}\s*from\s*"express";/g, 'import { Router, Request, Response, NextFunction } from "express";');
  content = content.replace(/import type \{ Request, Response, NextFunction, ErrorRequestHandler \} , Request\s*,\s*Response,\s*NextFunction\s*\}\s*from\s*"express";/g, 'import type { Request, Response, NextFunction, ErrorRequestHandler } from "express";');
  content = content.replace(/import\s*\{([^}]+)\}\s*,\s*Request,\s*Response,\s*NextFunction\s*\}\s*from\s*"express";/g, 'import { $1, Request, Response, NextFunction } from "express";');

  if (content !== original) {
    fs.writeFileSync(file, content);
    console.log("Fixed imports in", file);
  }
}
