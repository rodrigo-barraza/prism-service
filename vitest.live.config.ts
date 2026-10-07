import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/live/**/*.live.test.{ts,js}"],
    // Every request to the Prism under test signs in (helpers/liveAuth.ts).
    setupFiles: ["./tests/live/helpers/liveAuth.ts"],
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});
