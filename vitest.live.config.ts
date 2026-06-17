import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/live/**/*.live.test.{ts,js}"],
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});
