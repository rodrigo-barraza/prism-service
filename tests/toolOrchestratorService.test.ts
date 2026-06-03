import "./setup.ts";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ToolOrchestratorService from "../src/services/ToolOrchestratorService.ts";

vi.mock("../src/services/FileService.ts", () => {
  return {
    default: {
      extractKey: (imageReference: string) => imageReference.replace("minio://", ""),
      getFile: vi.fn().mockImplementation(async (keyString: string) => {
        if (keyString === "valid-image.png") {
          return {
            stream: (async function* () {
              yield Buffer.from("fake-minio-image-bytes");
            })(),
            contentType: "image/png",
          };
        }
        return null;
      }),
    },
  };
});

describe("ToolOrchestratorService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getClientToolSchemas", () => {
    it("correctly enriches client schemas with inputModalities matching shared taxonomy", async () => {
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

      vi.mocked(global.fetch).mockImplementation(async (url, requestOptions) => {
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

      await ToolOrchestratorService.refreshSchemas();

      const clientSchemas = ToolOrchestratorService.getClientToolSchemas();

      const generateImageSchema = clientSchemas.find((tool) => tool.name === "generate_image") as any;
      expect(generateImageSchema).toBeDefined();
      expect(generateImageSchema?.inputModalities).toEqual(["image"]);

      const speechToTextSchema = clientSchemas.find((tool) => tool.name === "speech_to_text") as any;
      expect(speechToTextSchema).toBeDefined();
      expect(speechToTextSchema?.inputModalities).toEqual(["audio"]);

      const getWeatherSchema = clientSchemas.find((tool) => tool.name === "get_weather") as any;
      expect(getWeatherSchema).toBeDefined();
      expect(getWeatherSchema?.inputModalities).toBeUndefined();
    });
  });

  describe("executeTool image-to-texture data injection", () => {
    const mockSchemas = [
      {
        name: "create_3d_model",
        description: "Create a 3D model",
        parameters: { type: "object", properties: {} },
        domain: "Workspace",
        endpoint: { path: "/compute/3d/model", method: "POST" },
      },
      {
        name: "create_3d_scene",
        description: "Create a 3D scene",
        parameters: { type: "object", properties: {} },
        domain: "Workspace",
        endpoint: { path: "/compute/3d/scene", method: "POST" },
      },
    ];

    it("does not inject referenceTextureUrl when no images are present in messages", async () => {
      let capturedBody: any = null;

      vi.mocked(global.fetch).mockImplementation(async (url, requestOptions) => {
        const urlString = String(url);
        if (urlString.includes("/compute/3d/model")) {
          if (requestOptions && requestOptions.body) {
            capturedBody = JSON.parse(requestOptions.body as string);
          }
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ success: true }),
          } as any;
        }
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

      await ToolOrchestratorService.refreshSchemas();

      await ToolOrchestratorService.executeTool(
        "create_3d_model",
        { objects: [] },
        {
          messages: [
            {
              role: "user",
              content: "Hello",
            },
          ],
        }
      );

      expect(capturedBody).toBeDefined();
      expect(capturedBody.referenceTextureUrl).toBeUndefined();
    });

    it("injects data URL as referenceTextureUrl when a data URL image is attached", async () => {
      let capturedBody: any = null;

      vi.mocked(global.fetch).mockImplementation(async (url, requestOptions) => {
        const urlString = String(url);
        if (urlString.includes("/compute/3d/model")) {
          if (requestOptions && requestOptions.body) {
            capturedBody = JSON.parse(requestOptions.body as string);
          }
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ success: true }),
          } as any;
        }
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

      await ToolOrchestratorService.refreshSchemas();

      const fakeDataUrl = "data:image/png;base64,fakebase64data";
      await ToolOrchestratorService.executeTool(
        "create_3d_model",
        { objects: [] },
        {
          messages: [
            {
              role: "user",
              images: [fakeDataUrl],
            },
          ],
        }
      );

      expect(capturedBody).toBeDefined();
      expect(capturedBody.referenceTextureUrl).toBe(fakeDataUrl);
    });

    it("injects HTTP URL as referenceTextureUrl when a web image URL is attached", async () => {
      let capturedBody: any = null;

      vi.mocked(global.fetch).mockImplementation(async (url, requestOptions) => {
        const urlString = String(url);
        if (urlString.includes("/compute/3d/scene")) {
          if (requestOptions && requestOptions.body) {
            capturedBody = JSON.parse(requestOptions.body as string);
          }
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ success: true }),
          } as any;
        }
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

      await ToolOrchestratorService.refreshSchemas();

      const fakeHttpUrl = "https://example.com/texture.png";
      await ToolOrchestratorService.executeTool(
        "create_3d_scene",
        { objects: [] },
        {
          messages: [
            {
              role: "user",
              images: [fakeHttpUrl],
            },
          ],
        }
      );

      expect(capturedBody).toBeDefined();
      expect(capturedBody.referenceTextureUrl).toBe(fakeHttpUrl);
    });

    it("resolves and injects minio URL as base64 data URL texture", async () => {
      let capturedBody: any = null;

      vi.mocked(global.fetch).mockImplementation(async (url, requestOptions) => {
        const urlString = String(url);
        if (urlString.includes("/compute/3d/model")) {
          if (requestOptions && requestOptions.body) {
            capturedBody = JSON.parse(requestOptions.body as string);
          }
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ success: true }),
          } as any;
        }
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

      await ToolOrchestratorService.refreshSchemas();

      const minioReference = "minio://valid-image.png";
      await ToolOrchestratorService.executeTool(
        "create_3d_model",
        { objects: [] },
        {
          messages: [
            {
              role: "user",
              images: [minioReference],
            },
          ],
        }
      );

      expect(capturedBody).toBeDefined();
      expect(capturedBody.referenceTextureUrl).toBe("data:image/png;base64,ZmFrZS1taW5pby1pbWFnZS1ieXRlcw==");
    });
  });
});
