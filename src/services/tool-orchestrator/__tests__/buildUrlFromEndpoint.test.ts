import { describe, it, expect, vi } from "vitest";

/**
 * Tests for buildUrlFromEndpoint — the URL builder that serializes tool call
 * arguments into HTTP query parameters for tools-api dispatch.
 *
 * The critical fix verified here: non-string values (arrays, objects) in
 * queryParams must be JSON.stringify'd rather than String()-coerced, which
 * would produce "[object Object]" instead of valid JSON.
 */

// Mock #config to prevent the deep transitive import chain
vi.mock("#config", () => ({
  TOOLS_SERVICE_URL: "https://api.tools.rod.dev",
  TOOLS_SERVICE_API_KEY: "test-key",
  PRISM_SERVICE_PORT: 7777,
  OPENAI_API_KEY: undefined,
  ANTHROPIC_API_KEY: undefined,
  GOOGLE_CLOUD_GEMINI_API_KEY: undefined,
  ELEVENLABS_API_KEY: undefined,
  INWORLD_BASIC: undefined,
  PROVIDER_LM_STUDIO: [],
  PROVIDER_VLLM: [],
  PROVIDER_OLLAMA: [],
  PROVIDER_LLAMA_CPP: [],
  MONGO_URI: "",
  MONGO_DB_NAME: "prism",
  MINIO_ENDPOINT: undefined,
  MINIO_ACCESS_KEY: undefined,
  MINIO_SECRET_KEY: undefined,
  MINIO_BUCKET_NAME: "prism",
  LIVE_AUDIO_MODEL: undefined,
  OPENAI_TRANSCRIPTION_MODEL: undefined,
  GOOGLE_TEXT_TO_SPEECH_MODEL: undefined,
  GOOGLE_EMBEDDING_MODEL: undefined,
  MODELS: {},
}));

// Mock the global registry to prevent side-effects on import
vi.mock("#src/types/GlobalToolOrchestratorRegistry", () => ({
  registerGlobalToolOrchestratorService: vi.fn(),
}));

// Stub fetch globally so the module can load without network calls
vi.stubGlobal("fetch", vi.fn());

import { buildUrlFromEndpoint } from "../ToolOrchestratorService.ts";
import type { ToolEndpoint } from "../types.ts";

describe("buildUrlFromEndpoint", () => {
  describe("query parameter serialization", () => {
    const baseEndpoint: ToolEndpoint = {
      path: "/utility/map",
      queryParams: ["markers", "zoom", "maptype"],
    };

    it("should JSON.stringify array values in query params", () => {
      const markers = [
        { latitude: 49.2797275, longitude: -123.1156217, label: "Central Library" },
        { latitude: 49.2643802, longitude: -123.1003016, label: "Mount Pleasant Branch" },
      ];

      const url = buildUrlFromEndpoint(baseEndpoint, { markers });

      const parsedUrl = new URL(url);
      const markersParam = parsedUrl.searchParams.get("markers");
      expect(markersParam).not.toBeNull();

      const parsedMarkers = JSON.parse(markersParam!);
      expect(parsedMarkers).toEqual(markers);
      expect(parsedMarkers).toHaveLength(2);
      expect(parsedMarkers[0].latitude).toBe(49.2797275);
      expect(parsedMarkers[0].label).toBe("Central Library");
    });

    it("should JSON.stringify object values in query params", () => {
      const endpoint: ToolEndpoint = {
        path: "/some/tool",
        queryParams: ["config"],
      };
      const config = { theme: "dark", zoom: 12 };

      const url = buildUrlFromEndpoint(endpoint, { config });

      const parsedUrl = new URL(url);
      const configParam = parsedUrl.searchParams.get("config");
      expect(JSON.parse(configParam!)).toEqual(config);
    });

    it("should use String() for primitive values (numbers, strings, booleans)", () => {
      const url = buildUrlFromEndpoint(baseEndpoint, {
        markers: "[already-a-string]",
        zoom: 14,
        maptype: "satellite",
      });

      const parsedUrl = new URL(url);
      expect(parsedUrl.searchParams.get("markers")).toBe("[already-a-string]");
      expect(parsedUrl.searchParams.get("zoom")).toBe("14");
      expect(parsedUrl.searchParams.get("maptype")).toBe("satellite");
    });

    it("should omit undefined, null, and empty string values", () => {
      const url = buildUrlFromEndpoint(baseEndpoint, {
        markers: [{ latitude: 49.28, longitude: -123.12 }],
        zoom: undefined,
        maptype: null,
      });

      const parsedUrl = new URL(url);
      expect(parsedUrl.searchParams.has("markers")).toBe(true);
      expect(parsedUrl.searchParams.has("zoom")).toBe(false);
      expect(parsedUrl.searchParams.has("maptype")).toBe(false);
    });

    it("should produce a URL that tools-service can JSON.parse the markers from", () => {
      const originalMarkers = [
        { latitude: 49.2797275, longitude: -123.1156217, label: "Central Library" },
        { latitude: 49.2437614, longitude: -123.1081017, label: "Terry Salman Branch" },
      ];

      const url = buildUrlFromEndpoint(baseEndpoint, { markers: originalMarkers });

      const parsedUrl = new URL(url);
      const rawQueryValue = parsedUrl.searchParams.get("markers")!;

      // Simulates what tools-service does: JSON.parse(markers) on the query string
      const serverSideParsed = JSON.parse(rawQueryValue);
      expect(serverSideParsed).toEqual(originalMarkers);
    });
  });

  describe("path parameter interpolation", () => {
    it("should replace :param placeholders with URL-encoded values", () => {
      const endpoint: ToolEndpoint = {
        path: "/users/:userId/profile",
        queryParams: [],
      };

      const url = buildUrlFromEndpoint(endpoint, { userId: "abc-123" });
      expect(url).toContain("/users/abc-123/profile");
    });

    it("should encode special characters in path params", () => {
      const endpoint: ToolEndpoint = {
        path: "/search/:query",
        queryParams: [],
      };

      const url = buildUrlFromEndpoint(endpoint, { query: "hello world & more" });
      expect(url).toContain("/search/hello%20world%20%26%20more");
    });
  });

  describe("conditional paths", () => {
    it("should use the conditional template when the trigger param is present", () => {
      const endpoint: ToolEndpoint = {
        path: "/default/path",
        conditionalPath: { param: "useAlternate", template: "/alternate/path" },
        queryParams: [],
      };

      const url = buildUrlFromEndpoint(endpoint, { useAlternate: true });
      expect(url).toContain("/alternate/path");
    });

    it("should use the default path when the trigger param is absent", () => {
      const endpoint: ToolEndpoint = {
        path: "/default/path",
        conditionalPath: { param: "useAlternate", template: "/alternate/path" },
        queryParams: [],
      };

      const url = buildUrlFromEndpoint(endpoint, {});
      expect(url).toContain("/default/path");
    });
  });
});
