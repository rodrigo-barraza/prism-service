/**
 * Write src/protocol/events.schema.json — the event protocol as JSON Schema
 * (draft 2020-12), generated from the zod schemas in src/protocol/events.ts.
 *
 *   node scripts/generate-protocol-schema.ts          write the file
 *   node scripts/generate-protocol-schema.ts --check  exit 1 when it is stale
 *
 * src/protocol/__tests__/eventProtocolContract.test.ts fails while the
 * checked-in file differs from a fresh generation.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildProtocolJsonSchema } from "../src/protocol/jsonSchema.ts";

const SCHEMA_PATH = fileURLToPath(new URL("../src/protocol/events.schema.json", import.meta.url));

const generated = `${JSON.stringify(buildProtocolJsonSchema(), null, 2)}\n`;

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(SCHEMA_PATH, "utf8");
  } catch {
    // Missing counts as stale.
  }
  if (current !== generated) {
    console.error(`${SCHEMA_PATH} is stale — run: node scripts/generate-protocol-schema.ts`);
    process.exit(1);
  }
  console.log(`${SCHEMA_PATH} is current.`);
} else {
  writeFileSync(SCHEMA_PATH, generated);
  console.log(`Wrote ${SCHEMA_PATH}`);
}
