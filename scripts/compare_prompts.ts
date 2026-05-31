import { bootstrapEnv } from "@rodrigo-barraza/utilities-library/vault";
import MongoWrapper from "../src/wrappers/MongoWrapper.ts";
import fs from "fs";

async function main() {
  await bootstrapEnv();

  const MONGO_URI = process.env.MONGO_URI;
  const MONGO_DB_NAME =
    process.env.PRISM_SERVICE_MONGO_DB_NAME ||
    process.env.PRISM_MONGO_DB_NAME ||
    process.env.MONGO_DB_NAME ||
    "prism";

  await MongoWrapper.createClient(MONGO_DB_NAME, MONGO_URI as string);
  const db = MongoWrapper.getDb(MONGO_DB_NAME);
  const col = db!.collection("requests");

  const r1Id = "15e986b3-df99-4b6e-91c5-2377b2691896-4";
  const r2Id = "cb1f7352-af6d-459b-a31b-0d728c62d48a-1";

  const r1 = await col.findOne({ requestId: r1Id }) || await col.findOne({ id: r1Id });
  const r2 = await col.findOne({ requestId: r2Id }) || await col.findOne({ id: r2Id });

  let out = "";
  
  function analyze(name: string, doc: any) {
    if (!doc) {
      out += `=== ${name} NOT FOUND ===\n\n`;
      return;
    }
    out += `=== ${name}: ${doc.requestId} ===\n`;
    out += `Agent: ${doc.agent}\n`;
    out += `Model: ${doc.model}\n`;
    out += `Options: ${JSON.stringify(doc.options, null, 2)}\n`;
    out += `Number of resolved tools (doc.tools): ${doc.tools?.length || 0}\n`;
    
    const sysMsg = doc.messages?.find((m: any) => m.role === "system");
    if (sysMsg) {
      out += `System Prompt Length: ${sysMsg.content?.length || 0} characters\n`;
      // Find the ## Available Tools section in the system prompt
      const content = sysMsg.content || "";
      const toolsIndex = content.indexOf("## Available Tools");
      if (toolsIndex !== -1) {
        out += `Found '## Available Tools' section!\n`;
        const sectionSnippet = content.slice(toolsIndex, toolsIndex + 500);
        out += `Section start snippet:\n${sectionSnippet}\n...\n`;
      } else {
        out += `Could NOT find '## Available Tools' section in system prompt.\n`;
      }
    } else {
      out += `No system message found!\n`;
    }
    out += "\n";
  }

  analyze("Parent Session (r1)", r1);
  analyze("Cron Job Fired (r2)", r2);

  fs.writeFileSync("scratch_comparison.txt", out);
  console.log("Comparison saved to scratch_comparison.txt successfully!");
}

main().catch(console.error).finally(() => process.exit(0));
