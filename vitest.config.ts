import { defineConfig } from "vitest/config";
import { serviceVitestConfig } from "@rodrigo-barraza/utilities-library/vitest";

export default defineConfig({
  ...serviceVitestConfig,
  test: {
    ...serviceVitestConfig.test,
    exclude: serviceVitestConfig.test?.exclude
      ? [...serviceVitestConfig.test.exclude, "**/dist/**"]
      : ["**/dist/**"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
