import { Project, SyntaxKind, Identifier } from "ts-morph";

const project = new Project({ tsConfigFilePath: "tsconfig.json" });

for (const sourceFile of project.getSourceFiles()) {
  let changed = false;

  // Fix Catch Clauses
  const catchClauses = sourceFile.getDescendantsOfKind(SyntaxKind.CatchClause);
  for (const cc of catchClauses) {
    const varDecl = cc.getVariableDeclaration();
    if (varDecl) {
      const name = varDecl.getName();
      // Rename variable to `e` to avoid naming conflicts if we do string replacements?
      // Better: find all references to this variable and replace them.
      const block = cc.getBlock();
      const identifiers = block.getDescendantsOfKind(SyntaxKind.Identifier);
      for (const id of identifiers) {
        if (id.getText() === name) {
          // Ensure this identifier resolves to our catch variable
          const symbol = id.getSymbol();
          const varSymbol = varDecl.getSymbol();
          if (symbol && varSymbol && symbol === varSymbol) {
            // It's a reference to the catch variable.
            // Replace `error.message` with `(error as Error).message`
            const parent = id.getParent();
            if (parent && parent.getKind() === SyntaxKind.PropertyAccessExpression) {
              id.replaceWithText(`(${name} as Error)`);
              changed = true;
            } else if (parent && parent.getKind() === SyntaxKind.TemplateSpan) {
              id.replaceWithText(`(${name} as Error)`);
              changed = true;
            }
          }
        }
      }
      
      // Also check if we just pass it to console.error(error)
      // actually, just cast it everywhere it's used if it's not already casted.
    }
  }

  // Fix empty object literals `{}` inferred as `{}` by adding `: Record<string, unknown>`
  const varDecls = sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
  for (const varDecl of varDecls) {
    if (!varDecl.getTypeNode()) {
      const init = varDecl.getInitializer();
      if (init && init.getKind() === SyntaxKind.ObjectLiteralExpression) {
        if (init.getText() === "{}" || init.getText() === "{\n}") {
           // check if there are assignments to this variable later
           const name = varDecl.getName();
           const refs = varDecl.findReferencesAsNodes();
           let hasPropAccess = false;
           for (const ref of refs) {
             const parent = ref.getParent();
             if (parent && (parent.getKind() === SyntaxKind.PropertyAccessExpression || parent.getKind() === SyntaxKind.ElementAccessExpression)) {
               hasPropAccess = true;
               break;
             }
           }
           if (hasPropAccess) {
             varDecl.setType("Record<string, unknown>");
             changed = true;
           }
        }
      } else if (init && init.getKind() === SyntaxKind.ArrayLiteralExpression) {
         if (init.getText() === "[]") {
           varDecl.setType("unknown[]");
           changed = true;
         }
      }
    }
  }

  // Fix implicitly 'unknown' variables in callbacks, e.g. .map(item => ...)
  const arrowFuncs = sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction);
  for (const af of arrowFuncs) {
    for (const param of af.getParameters()) {
      if (!param.getTypeNode()) {
        param.setType("unknown");
        changed = true;
      }
    }
  }
  
  const funcs = sourceFile.getDescendantsOfKind(SyntaxKind.FunctionExpression);
  for (const func of funcs) {
    for (const param of func.getParameters()) {
      if (!param.getTypeNode()) {
        param.setType("unknown");
        changed = true;
      }
    }
  }

  const funcDecls = sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration);
  for (const func of funcDecls) {
    for (const param of func.getParameters()) {
      if (!param.getTypeNode()) {
        param.setType("unknown");
        changed = true;
      }
    }
  }

  if (changed) {
    sourceFile.saveSync();
    console.log(`Fixed types in ${sourceFile.getBaseName()}`);
  }
}
