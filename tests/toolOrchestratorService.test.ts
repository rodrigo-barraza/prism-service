import "./setup.ts";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ToolOrchestratorService from "../src/services/ToolOrchestratorService.ts";


describe("ToolOrchestratorService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getClientToolSchemas", () => {
    it("correctly enriches client schemas with inputModalities matching shared taxonomy", async () => {
      // Mock global fetch to return specific schemas when refreshing/fetching schemas
      const mockSchemas = [
        {
          name: "generate_image",
          description: "Generate an image",
          domain: "Workspace",
          endpoint: { path: "/generate" },
        },
        {
          name: "speech_to_text",
          description: "Speech to text conversion",
          domain: "Audio",
          endpoint: { path: "/speech" },
        },
        {
          name: "get_weather",
          description: "Get weather details",
          domain: "Weather",
          endpoint: { path: "/weather" },
        },
      ];

      vi.mocked(global.fetch).mockImplementation(async (url) => {
        const urlString = String(url);
        if (urlString.includes("/admin/tool-schemas")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => mockSchemas,
          } as any;
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({}),
        } as any;
      });

      // Eagerly refresh schemas to populate the cache
      await ToolOrchestratorService.refreshSchemas();

      // Retrieve the enriched schemas
      const clientSchemas = ToolOrchestratorService.getClientToolSchemas();

      // Find generate_image schema and check its inputModalities
      const generateImageSchema = clientSchemas.find((tool) => tool.name === "generate_image");
      expect(generateImageSchema).toBeDefined();
      expect(generateImageSchema?.inputModalities).toEqual(["image"]);

      // Find speech_to_text schema and check its inputModalities
      const speechToTextSchema = clientSchemas.find((tool) => tool.name === "speech_to_text");
      expect(speechToTextSchema).toBeDefined();
      expect(speechToTextSchema?.inputModalities).toEqual(["audio"]);

      // Find get_weather schema and verify it does NOT have inputModalities
      const getWeatherSchema = clientSchemas.find((tool) => tool.name === "get_weather");
      expect(getWeatherSchema).toBeDefined();
      expect(getWeatherSchema?.inputModalities).toBeUndefined();
    });
  });
});
