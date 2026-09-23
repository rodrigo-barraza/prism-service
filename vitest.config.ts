import { defineConfig, configDefaults } from "vitest/config";
import { serviceVitestConfig } from "@rodrigo-barraza/utilities-library/vitest";

export default defineConfig({
  ...serviceVitestConfig,
  test: {
    ...serviceVitestConfig.test,
    // The shared config's exclude REPLACES vitest's defaults, so keep them
    // (`**/node_modules/**`, not just the root one). Then keep the deploy
    // gate, which runs from the main checkout, out of the task/batch
    // worktrees under .claude/ — their hard-linked node_modules carry vendor
    // specs and their tests are second copies (2026-09-22: the tools-service
    // gate collected 570 files and aborted on thread-stream's own specs).
    exclude: [
      ...configDefaults.exclude,
      ...(serviceVitestConfig.test?.exclude ?? []),
      "**/dist/**",
      ".claude/**",
    ],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
