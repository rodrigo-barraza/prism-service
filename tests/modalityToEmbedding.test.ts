import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { app, MOCK_GENERATE_EMBEDDING } from "./setup.ts";
import { PROVIDERS, MODALITY_TYPES } from "#src/constants";

describe("POST /modality-to-embedding", () => {
    beforeEach(() => {
        MOCK_GENERATE_EMBEDDING.mockClear();
        MOCK_GENERATE_EMBEDDING.mockResolvedValue({
            embedding: [0.1, 0.2, 0.3],
            dimensions: 3,
        });
    });

    // ── Required parameters ───────────────────────────────────────────

    it("returns 400 when provider is missing", async () => {
        const res = await request(app)
            .post("/embed")
            .send({ text: "Hello" })
            .expect(400);

        expect(res.body).toHaveProperty("error", true);
        expect(res.body.message).toMatch(/provider/i);
    });

    it("returns 400 when no content inputs provided", async () => {
        const res = await request(app)
            .post("/embed")
            .send({ provider: PROVIDERS.GOOGLE })
            .expect(400);

        expect(res.body).toHaveProperty("error", true);
        expect(res.body.message).toMatch(/content input/i);
    });

    // ── Successful requests ───────────────────────────────────────────

    it("returns 200 with text-only input", async () => {
        const res = await request(app)
            .post("/embed")
            .send({ provider: PROVIDERS.GOOGLE, text: "What is the meaning of life?" })
            .expect(200);

        expect(res.body).toHaveProperty(MODALITY_TYPES.EMBEDDING);
        expect(Array.isArray(res.body.embedding)).toBe(true);
        expect(res.body).toHaveProperty("dimensions", 3);
        expect(res.body).toHaveProperty("provider", PROVIDERS.GOOGLE);
    });

    it("returns 200 with image input", async () => {
        const res = await request(app)
            .post("/embed")
            .send({
                provider: PROVIDERS.GOOGLE,
                images: ["data:image/png;base64,iVBORw0KGgo="],
            })
            .expect(200);

        expect(res.body).toHaveProperty(MODALITY_TYPES.EMBEDDING);
        expect(res.body).toHaveProperty("provider", PROVIDERS.GOOGLE);
    });

    it("returns 200 with text + image multimodal input", async () => {
        const res = await request(app)
            .post("/embed")
            .send({
                provider: PROVIDERS.GOOGLE,
                text: "An image of a dog",
                images: ["data:image/png;base64,iVBORw0KGgo="],
            })
            .expect(200);

        expect(res.body).toHaveProperty(MODALITY_TYPES.EMBEDDING);
        // Multimodal should pass an array of parts to provider
        const args = MOCK_GENERATE_EMBEDDING.mock.calls[0];
        expect(Array.isArray(args[0])).toBe(true);
    });

    // ── Optional parameters ───────────────────────────────────────────

    it("passes taskType and dimensions via options", async () => {
        await request(app)
            .post("/embed")
            .send({
                provider: PROVIDERS.GOOGLE,
                text: "Hello",
                taskType: "SEMANTIC_SIMILARITY",
                dimensions: 768,
            })
            .expect(200);

        const options = MOCK_GENERATE_EMBEDDING.mock.calls[0][2];
        expect(options.taskType).toBe("SEMANTIC_SIMILARITY");
        expect(options.dimensions).toBe(768);
    });

    it("passes model to the provider when provided", async () => {
        await request(app)
            .post("/embed")
            .send({
                provider: PROVIDERS.GOOGLE,
                text: "Hello",
                model: "gemini-embedding-001",
            })
            .expect(200);

        const calledModel = MOCK_GENERATE_EMBEDDING.mock.calls[0][1];
        expect(calledModel).toBe("gemini-embedding-001");
    });

    // ── Error handling ────────────────────────────────────────────────

    it("returns 400 for provider that does not support embeddings", async () => {
        const res = await request(app)
            .post("/embed")
            .send({ provider: PROVIDERS.ELEVENLABS, text: "Hello" })
            .expect(400);

        expect(res.body).toHaveProperty("error", true);
        expect(res.body.message).toMatch(/embeddings/i);
    });

    it("returns 500 when provider throws", async () => {
        MOCK_GENERATE_EMBEDDING.mockRejectedValueOnce(
            new Error("Embedding service down"),
        );

        const res = await request(app)
            .post("/embed")
            .send({ provider: PROVIDERS.GOOGLE, text: "Hello" })
            .expect(500);

        expect(res.body).toHaveProperty("error", true);
    });

    it("returns error for unknown provider", async () => {
        const res = await request(app)
            .post("/embed")
            .send({ provider: "nonexistent", text: "Hello" })
            .expect(500);

        expect(res.body).toHaveProperty("error", true);
    });
});
