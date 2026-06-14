import { describe, it, vi } from "vitest";
import AgenticToolResolver from "../src/services/AgenticToolResolver.ts";
import ToolOrchestratorService from "../src/services/ToolOrchestratorService.ts";

vi.mock("../src/wrappers/MongoWrapper.ts", () => ({
  default: {
    getCollection: vi.fn(() => ({
      findOne: vi.fn().mockResolvedValue(null),
    })),
  },
}));

vi.mock("../src/services/SettingsService.ts", () => ({
  default: {
    getCached: vi.fn().mockReturnValue({ creative: { textToSpeechProvider: "elevenlabs" } }),
    getSection: vi.fn().mockResolvedValue({}),
  },
}));

describe("Inspect OMNI Tools", () => {
  it("prints OMNI tools", async () => {
    // Set environment variable so fetchSchemas fallback doesn't crash on undefined URL
    process.env.TOOLS_SERVICE_URL = "http://localhost:5556";
    
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {},
      agent: "OMNI",
      project: "prism-chat",
      username: "rodrigo",
    });
    console.log("FINAL OMNI TOOLS COUNT:", finalTools.length);
    console.log("FINAL OMNI TOOLS:", finalTools.map((t) => t.name).sort());
  });
});

