import { bootstrapEnvironment } from "@rodrigo-barraza/utilities-library/vault";
await bootstrapEnvironment();
console.log("TOOLS_SERVICE_URL:", process.env.TOOLS_SERVICE_URL);
process.exit(0);
