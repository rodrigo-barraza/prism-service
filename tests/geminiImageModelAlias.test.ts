/**
 * geminiImageModelAlias.test.ts
 *
 * tools-service's generate_image calls POST /chat with
 * `gemini-3-pro-image-preview` (utilities-library MODEL_IDS.geminiImagePro);
 * the catalog lists the model as `gemini-3-pro-image`. Unmapped, the request
 * had no model definition — so it streamed a model the catalog marks
 * `streaming: false`, lost its IMAGE output modality, and logged at $0 (194
 * images in 30 days). The requested ID is now resolved to the catalog one
 * where the request's model is picked, so the provider call, the
 * definition, the request log and the price all see gemini-3-pro-image.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import supertest from "supertest";
import { app, MOCK_GENERATE_TEXT, MOCK_GENERATE_TEXT_STREAM } from "./setup.ts";
import RequestLogger from "#src/services/RequestLogger";
import {
  MODALITY_TYPES,
  getModelByName,
  getPricing,
  resolveModelAlias,
} from "#src/config";
import { PROVIDERS } from "#src/constants";

const PREVIEW_ID = "gemini-3-pro-image-preview";
const CATALOG_ID = "gemini-3-pro-image";

const IMAGE_RESULT = {
  text: "",
  images: [{ data: "iVBORw0KGgo=", mimeType: "image/png" }],
  usage: { inputTokens: 420, outputTokens: 1120 },
};

async function generateImage(model: string) {
  return supertest(app)
    .post("/chat?stream=false")
    .set("x-project", "tools")
    .set("x-username", "tools-service")
    .send({
      provider: PROVIDERS.GOOGLE,
      model,
      forceImageGeneration: true,
      skipConversation: true,
      messages: [{ role: "user", content: "A wolf king eating donuts, comic style" }],
    });
}

/** The request row the call logged. */
function loggedRequest(): { model?: string; estimatedCost?: number | null } {
  const calls = vi.mocked(RequestLogger.logChatGeneration).mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0][0] as { model?: string; estimatedCost?: number | null };
}

beforeEach(() => {
  vi.clearAllMocks();
  MOCK_GENERATE_TEXT.mockResolvedValue(IMAGE_RESULT);
});

describe("gemini-3-pro-image-preview on POST /chat", () => {
  it("reaches the provider as gemini-3-pro-image, with that model's definition", async () => {
    const response = await generateImage(PREVIEW_ID);

    expect(response.status).toBe(200);
    // The catalog definition says streaming: false — the generateText path.
    expect(MOCK_GENERATE_TEXT_STREAM).not.toHaveBeenCalled();
    expect(MOCK_GENERATE_TEXT).toHaveBeenCalledTimes(1);
    const [, model, options] = MOCK_GENERATE_TEXT.mock.calls[0];
    expect(model).toBe(CATALOG_ID);
    expect(options).toMatchObject({ forceImageGeneration: true });
    expect(loggedRequest().model).toBe(CATALOG_ID);
  });

  it("is priced — non-zero, and exactly what gemini-3-pro-image costs", async () => {
    await generateImage(PREVIEW_ID);
    const previewCost = loggedRequest().estimatedCost;

    vi.clearAllMocks();
    MOCK_GENERATE_TEXT.mockResolvedValue(IMAGE_RESULT);
    await generateImage(CATALOG_ID);
    const catalogCost = loggedRequest().estimatedCost;

    expect(previewCost).toBeGreaterThan(0);
    expect(previewCost).toBe(catalogCost);
  });
});

describe("model ID aliases in the catalog lookups", () => {
  it("resolves the preview ID to the catalog model and leaves every other ID alone", () => {
    expect(resolveModelAlias(PREVIEW_ID)).toBe(CATALOG_ID);
    expect(resolveModelAlias(CATALOG_ID)).toBe(CATALOG_ID);
    expect(resolveModelAlias("gemini-3.1-flash-image")).toBe("gemini-3.1-flash-image");
  });

  it("defines and prices the preview ID as the catalog model for any other lookup", () => {
    const catalogModel = getModelByName(CATALOG_ID);
    expect(catalogModel).not.toBeNull();
    expect(getModelByName(PREVIEW_ID)).toBe(catalogModel);

    const imagePricing = getPricing(MODALITY_TYPES.TEXT, MODALITY_TYPES.IMAGE);
    expect(imagePricing[PREVIEW_ID]).toEqual(imagePricing[CATALOG_ID]);
    expect(imagePricing[PREVIEW_ID]?.imageOutputPerMillion).toBeGreaterThan(0);
  });
});
