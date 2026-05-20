// ─── Boot Sequence ──────────────────────────────────────────

import { bootstrapEnv } from "@rodrigo-barraza/utilities-library/vault";

await bootstrapEnv();

// Now import the actual app — all modules will read from process.env
// via config.js, which is a typed accessor layer over process.env.
await import("./index.ts");
