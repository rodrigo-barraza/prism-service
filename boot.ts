// ─── Boot Sequence ──────────────────────────────────────────

import { bootstrapEnvironment } from "@rodrigo-barraza/utilities-library/vault";

await bootstrapEnvironment();

// OpenTelemetry traces — a no-op unless an OTLP endpoint is configured
// (OTEL_EXPORTER_OTLP_ENDPOINT / OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).
const { startTracing } = await import("./src/services/Tracing.ts");
await startTracing();

// Now import the actual app — all modules will read from process.env
// via config.js, which is a typed accessor layer over process.env.
await import("./src/index.ts");
