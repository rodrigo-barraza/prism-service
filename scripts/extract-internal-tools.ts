import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import InternalToolRegistry from "../src/services/local-tools/InternalToolRegistry.ts";

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFilePath);
const targetLocalePath = path.resolve(
  currentDirectory,
  "..",
  "src",
  "locales",
  "en",
  "internal-tools.json",
);

function runExtraction() {
  const toolSchemas = InternalToolRegistry.getSchemas();
  const localeContent: Record<string, unknown> = {};

  for (const schema of toolSchemas) {
    const toolName = schema.name;
    const parameters = schema.parameters;
    const properties = parameters?.properties;

    const parameterDescriptions: Record<string, string> = {};
    if (properties) {
      for (const [propertyName, propertyValue] of Object.entries(properties)) {
        if (propertyValue && typeof propertyValue === "object") {
          const descriptionValue = (propertyValue as Record<string, unknown>).description;
          if (typeof descriptionValue === "string") {
            parameterDescriptions[propertyName] = descriptionValue;
          }
        }
      }
    }

    localeContent[toolName] = {
      description: schema.description || "",
      ...(Object.keys(parameterDescriptions).length > 0 && {
        parameters: parameterDescriptions,
      }),
    };
  }

  const outputDirectory = path.dirname(targetLocalePath);
  if (!fs.existsSync(outputDirectory)) {
    fs.mkdirSync(outputDirectory, { recursive: true });
  }

  fs.writeFileSync(
    targetLocalePath,
    JSON.stringify(localeContent, null, 2) + "\n",
    "utf-8",
  );

  console.log(`Successfully extracted ${toolSchemas.length} internal tool schemas to ${targetLocalePath}`);
}

runExtraction();
