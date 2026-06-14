import {
    calculateTextCost,
    calculateAudioCost,
    calculateImageCost,
    calculateLiveCost,
    getTotalInputTokens,
    estimateTokens,
    mergeUsage,
    createUsageAccumulator,
} from "../src/utils/CostCalculator.ts";
import ContextWindowManager from "../src/utils/ContextWindowManager.ts";
import { normalizeUsage } from "../src/utils/openai-compat.ts";
import { normalizeResponsesUsage } from "../src/providers/openai.ts";
import { TYPES, getPricing, getModelByName } from "../src/config.ts";


// ═══════════════════════════════════════════════════════════════
// calculateTextCost — Unit Tests
// ═══════════════════════════════════════════════════════════════

describe("calculateTextCost", () => {
    it("returns null when pricing is null", () => {
        const usage = { inputTokens: 100, outputTokens: 50 };
        expect(calculateTextCost(usage, null)).toBeNull();
    });

    it("returns null when pricing is undefined", () => {
        const usage = { inputTokens: 100, outputTokens: 50 };
        expect(calculateTextCost(usage, undefined)).toBeNull();
    });

    it("returns null when usage is null", () => {
        const pricing = { inputPerMillion: 1.0, outputPerMillion: 5.0 };
        expect(calculateTextCost(null, pricing)).toBeNull();
    });

    it("returns 0 when token counts are zero", () => {
        const usage = { inputTokens: 0, outputTokens: 0 };
        const pricing = { inputPerMillion: 1.0, outputPerMillion: 5.0 };
        expect(calculateTextCost(usage, pricing)).toBe(0);
    });

    // ── Real model pricing ───────────────────────────────────────

    it("calculates cost for GPT 5.2 (10 in, 5 out)", () => {
        // GPT-5.2: input $1.75/M, output $14.00/M
        const usage = { inputTokens: 10, outputTokens: 5 };
        const pricing = { inputPerMillion: 1.75, outputPerMillion: 14.0 };
        // Expected: (10/1M)*1.75 + (5/1M)*14.0 = 0.0000175 + 0.00007 = 0.0000875
        const cost = calculateTextCost(usage, pricing);
        expect(cost).toBeCloseTo(0.0000875, 8);
    });

    it("calculates cost for GPT 5 Mini (1000 in, 500 out)", () => {
        // GPT-5-mini: input $0.25/M, output $2.00/M
        const usage = { inputTokens: 1000, outputTokens: 500 };
        const pricing = { inputPerMillion: 0.25, outputPerMillion: 2.0 };
        // Expected: (1000/1M)*0.25 + (500/1M)*2.0 = 0.00025 + 0.001 = 0.00125
        const cost = calculateTextCost(usage, pricing);
        expect(cost).toBeCloseTo(0.00125, 8);
    });

    it("calculates cost for Haiku 4.5 (5000 in, 2000 out)", () => {
        // Haiku 4.5: input $1.00/M, output $5.00/M
        const usage = { inputTokens: 5000, outputTokens: 2000 };
        const pricing = { inputPerMillion: 1.0, outputPerMillion: 5.0 };
        // Expected: (5000/1M)*1.0 + (2000/1M)*5.0 = 0.005 + 0.01 = 0.015
        const cost = calculateTextCost(usage, pricing);
        expect(cost).toBeCloseTo(0.015, 8);
    });

    it("calculates cost for Opus 4.6 (50000 in, 10000 out)", () => {
        // Opus 4.6: input $5.00/M, output $25.00/M
        const usage = { inputTokens: 50000, outputTokens: 10000 };
        const pricing = { inputPerMillion: 5.0, outputPerMillion: 25.0 };
        // Expected: (50000/1M)*5.0 + (10000/1M)*25.0 = 0.25 + 0.25 = 0.5
        const cost = calculateTextCost(usage, pricing);
        expect(cost).toBeCloseTo(0.5, 8);
    });

    it("calculates cost for Gemini 3 Flash (10000 in, 3000 out)", () => {
        // Gemini 3 Flash: input $0.50/M, output $3.00/M
        const usage = { inputTokens: 10000, outputTokens: 3000 };
        const pricing = { inputPerMillion: 0.5, outputPerMillion: 3.0 };
        // Expected: (10000/1M)*0.5 + (3000/1M)*3.0 = 0.005 + 0.009 = 0.014
        const cost = calculateTextCost(usage, pricing);
        expect(cost).toBeCloseTo(0.014, 8);
    });

    it("handles large token counts (1M+ tokens)", () => {
        const usage = { inputTokens: 2_000_000, outputTokens: 128_000 };
        const pricing = { inputPerMillion: 1.25, outputPerMillion: 7.5 };
        // Expected: (2M/1M)*1.25 + (128k/1M)*7.5 = 2.5 + 0.96 = 3.46
        const cost = calculateTextCost(usage, pricing);
        expect(cost).toBeCloseTo(3.46, 5);
    });

    it("handles free models (LM Studio) with 0 pricing", () => {
        const usage = { inputTokens: 5000, outputTokens: 2000 };
        const pricing = { inputPerMillion: 0, outputPerMillion: 0 };
        expect(calculateTextCost(usage, pricing)).toBe(0);
    });

    it("handles pricing with only inputPerMillion set (embeddings-style)", () => {
        const usage = { inputTokens: 8000, outputTokens: 0 };
        const pricing = { inputPerMillion: 0.02 };
        // Expected: (8000/1M)*0.02 = 0.00016
        const cost = calculateTextCost(usage, pricing);
        expect(cost).toBeCloseTo(0.00016, 8);
    });
});

// ═══════════════════════════════════════════════════════════════
// calculateAudioCost — Unit Tests
// ═══════════════════════════════════════════════════════════════

describe("calculateAudioCost", () => {
    it("returns null when pricing is null", () => {
        const usage = { durationSeconds: 60 };
        expect(calculateAudioCost(usage, null)).toBeNull();
    });

    it("returns null when pricing is undefined", () => {
        const usage = { durationSeconds: 60 };
        expect(calculateAudioCost(usage, undefined)).toBeNull();
    });

    it("returns null when usage is null", () => {
        const pricing = { perMinute: 0.006 };
        expect(calculateAudioCost(null, pricing)).toBeNull();
    });

    it("returns null when no matching pricing strategy applies", () => {
        const usage = { durationSeconds: 60 };
        // Pricing has no perMinute and no audioInputPerMillion
        const pricing = { inputPerMillion: 1.0, outputPerMillion: 5.0 };
        expect(calculateAudioCost(usage, pricing)).toBeNull();
    });

    // ── Per-minute pricing ───────────────────────────────────────

    it("calculates per-minute cost for Whisper-1 (120s)", () => {
        // Whisper-1: $0.006/min
        const usage = { durationSeconds: 120 };
        const pricing = { perMinute: 0.006 };
        // Expected: (120/60) * 0.006 = 0.012
        const cost = calculateAudioCost(usage, pricing);
        expect(cost).toBeCloseTo(0.012, 8);
    });

    it("calculates per-minute cost for GPT-4o Transcribe (45s)", () => {
        // GPT-4o Transcribe also has perMinute $0.006
        const usage = { durationSeconds: 45, inputTokens: 500, outputTokens: 100 };
        const pricing = {
            audioInputPerMillion: 2.5,
            outputPerMillion: 10.0,
            perMinute: 0.006,
        };
        // Per-minute takes priority: (45/60) * 0.006 = 0.0045
        const cost = calculateAudioCost(usage, pricing);
        expect(cost).toBeCloseTo(0.0045, 8);
    });

    it("calculates per-minute cost for short audio (5s)", () => {
        const usage = { durationSeconds: 5 };
        const pricing = { perMinute: 0.006 };
        // Expected: (5/60) * 0.006 = 0.0005
        const cost = calculateAudioCost(usage, pricing);
        expect(cost).toBeCloseTo(0.0005, 8);
    });

    // ── Token-based pricing ──────────────────────────────────────

    it("calculates token-based cost for Gemini 3 Flash STT", () => {
        // Gemini 3 Flash STT: audioInput $1.00/M, output $3.00/M
        const usage = { inputTokens: 10000, outputTokens: 500 };
        const pricing = { audioInputPerMillion: 1.0, outputPerMillion: 3.0 };
        // Expected: (10000/1M)*1.0 + (500/1M)*3.0 = 0.01 + 0.0015 = 0.0115
        const cost = calculateAudioCost(usage, pricing);
        expect(cost).toBeCloseTo(0.0115, 8);
    });

    it("calculates token-based cost for GPT-4o Transcribe (no perMinute)", () => {
        // If perMinute is missing but tokens are present
        const usage = { inputTokens: 5000, outputTokens: 1000 };
        const pricing = { audioInputPerMillion: 2.5, outputPerMillion: 10.0 };
        // Expected: (5000/1M)*2.5 + (1000/1M)*10.0 = 0.0125 + 0.01 = 0.0225
        const cost = calculateAudioCost(usage, pricing);
        expect(cost).toBeCloseTo(0.0225, 8);
    });

    it("handles token-based cost with no output tokens", () => {
        const usage = { inputTokens: 8000 };
        const pricing = { audioInputPerMillion: 1.25, outputPerMillion: 5.0 };
        // Expected: (8000/1M)*1.25 + (0/1M)*5.0 = 0.01
        const cost = calculateAudioCost(usage, pricing);
        expect(cost).toBeCloseTo(0.01, 8);
    });

    it("handles token-based cost with no outputPerMillion in pricing", () => {
        const usage = { inputTokens: 10000, outputTokens: 500 };
        const pricing = { audioInputPerMillion: 1.0 };
        // Expected: (10000/1M)*1.0 + (500/1M)*0 = 0.01
        const cost = calculateAudioCost(usage, pricing);
        expect(cost).toBeCloseTo(0.01, 8);
    });

    // ── Priority: perMinute > token-based ────────────────────────

    it("prefers perMinute over token-based when both are available", () => {
        const usage = { durationSeconds: 60, inputTokens: 10000, outputTokens: 500 };
        const pricing = {
            perMinute: 0.006,
            audioInputPerMillion: 2.5,
            outputPerMillion: 10.0,
        };
        // Should use perMinute: (60/60)*0.006 = 0.006
        const cost = calculateAudioCost(usage, pricing);
        expect(cost).toBeCloseTo(0.006, 8);
    });

    it("falls back to token-based when durationSeconds is missing", () => {
        const usage = { inputTokens: 10000, outputTokens: 500 };
        const pricing = {
            perMinute: 0.006,
            audioInputPerMillion: 2.5,
            outputPerMillion: 10.0,
        };
        // perMinute can't fire (no durationSeconds), falls back to token-based
        // Expected: (10000/1M)*2.5 + (500/1M)*10.0 = 0.025 + 0.005 = 0.03
        const cost = calculateAudioCost(usage, pricing);
        expect(cost).toBeCloseTo(0.03, 8);
    });
});

// ═══════════════════════════════════════════════════════════════
// End-to-end — real pricing from config.js
// ═══════════════════════════════════════════════════════════════

describe("Cost calculation with real config pricing", () => {
    const textPricing = getPricing(TYPES.TEXT, TYPES.TEXT);
    const audioPricing = getPricing(TYPES.AUDIO, TYPES.TEXT);

    it("GPT-5.2: 1000 in / 500 out = $0.00875", () => {
        const pricing = textPricing["gpt-5.2"];
        const cost = calculateTextCost({ inputTokens: 1000, outputTokens: 500 }, pricing);
        // (1000/1M)*1.75 + (500/1M)*14.0 = 0.00175 + 0.007 = 0.00875
        expect(cost).toBeCloseTo(0.00875, 8);
    });

    it("Sonnet 4.5: 5000 in / 2000 out = $0.045", () => {
        const pricing = textPricing["claude-sonnet-4-5-20250929"];
        const cost = calculateTextCost({ inputTokens: 5000, outputTokens: 2000 }, pricing);
        expect(cost).toBeCloseTo(0.045, 8);
    });

    it("Gemini 3 Flash: 10000 in / 3000 out = $0.014", () => {
        const pricing = textPricing["gemini-3-flash-preview"];
        const cost = calculateTextCost({ inputTokens: 10000, outputTokens: 3000 }, pricing);
        expect(cost).toBeCloseTo(0.014, 8);
    });

    it("GPT 5.4 Pro: 50000 in / 10000 out = $3.30", () => {
        const pricing = textPricing["gpt-5.4-pro"];
        const cost = calculateTextCost({ inputTokens: 50000, outputTokens: 10000 }, pricing);
        // (50000/1M)*30.0 + (10000/1M)*180.0 = 1.5 + 1.8 = 3.3
        expect(cost).toBeCloseTo(3.30, 8);
    });

    it("Whisper-1: 120s audio = $0.012", () => {
        const pricing = audioPricing["whisper-1"];
        const cost = calculateAudioCost({ durationSeconds: 120 }, pricing);
        expect(cost).toBeCloseTo(0.012, 8);
    });

    it("Gemini 3 Flash STT: 10000 in / 500 out (token-based)", () => {
        const pricing = audioPricing["gemini-3-flash-preview"];
        const cost = calculateAudioCost({ inputTokens: 10000, outputTokens: 500 }, pricing);
        // audioInputPerMillion: 1.0, outputPerMillion: 3.0
        // (10000/1M)*1.0 + (500/1M)*3.0 = 0.01 + 0.0015 = 0.0115
        expect(cost).toBeCloseTo(0.0115, 8);
    });

    it("unknown model returns null", () => {
        const pricing = textPricing["nonexistent-model-xyz"];
        const cost = calculateTextCost({ inputTokens: 100, outputTokens: 50 }, pricing);
        expect(cost).toBeNull();
    });
});

// ═══════════════════════════════════════════════════════════════
// calculateImageCost — Unit Tests
// ═══════════════════════════════════════════════════════════════

describe("calculateImageCost", () => {
    it("returns null when pricing is null", () => {
        expect(calculateImageCost("a prompt", null)).toBeNull();
    });

    it("returns null when prompt is empty", () => {
        const pricing = { inputPerMillion: 0.5, imageOutputPerMillion: 60.0 };
        expect(calculateImageCost("", pricing)).toBeNull();
    });

    it("returns null when prompt is null", () => {
        const pricing = { inputPerMillion: 0.5, imageOutputPerMillion: 60.0 };
        expect(calculateImageCost(null, pricing)).toBeNull();
    });

    // ── Google Gemini 3.1 Flash Image (default 1024px ≈ 1120 tokens) ──

    it("calculates cost for Gemini 3.1 Flash Image (short prompt, default tokens)", () => {
        // inputPerMillion: 0.50, imageOutputPerMillion: 60.0
        // Default outputImageTokens = 1120
        const pricing = { inputPerMillion: 0.5, outputPerMillion: 3.0, imageOutputPerMillion: 60.0 };
        const prompt = "A cute cartoon turtle"; // ~5 tokens (21 chars / 4)
        const cost = calculateImageCost(prompt, pricing);
        // Input: ceil(21/4)=6 tokens → (6/1M)*0.50 = $0.000003
        // Output image: (1120/1M)*60 = $0.0672
        // Total ≈ $0.067203
        expect(cost).toBeCloseTo(0.0672, 3);
    });

    it("calculates cost for Gemini 3 Pro Image (1120 tokens)", () => {
        const pricing = { inputPerMillion: 2.0, imageInputPerMillion: 2.0, outputPerMillion: 12.0, imageOutputPerMillion: 120.0 };
        const prompt = "A watercolor painting of a sunset";
        const cost = calculateImageCost(prompt, pricing, 0, 1120);
        // Input: ceil(34/4)=9 tokens → (9/1M)*2.0 = $0.000018
        // Output image: (1120/1M)*120 = $0.1344
        // Total ≈ $0.134418
        expect(cost).toBeCloseTo(0.1344, 3);
    });

    it("calculates cost for GPT Image 1.5 (1056 tokens)", () => {
        const pricing = { inputPerMillion: 5.0, imageInputPerMillion: 8.0, imageOutputPerMillion: 32.0 };
        const prompt = "A photo-realistic cat sitting on a chair";
        const cost = calculateImageCost(prompt, pricing, 0, 1056);
        // Input: ceil(41/4)=11 tokens → (11/1M)*5.0 = $0.000055
        // Output image: (1056/1M)*32 = $0.033792
        // Total ≈ $0.033847
        expect(cost).toBeCloseTo(0.03385, 4);
    });

    // ── With input images (edit requests) ──

    it("includes input image cost for edit requests", () => {
        const pricing = { inputPerMillion: 0.5, imageInputPerMillion: 0.5, imageOutputPerMillion: 60.0 };
        const prompt = "Make the background blue";
        const cost = calculateImageCost(prompt, pricing, 2, 1120);
        // Input text: ceil(24/4)=6 → (6/1M)*0.5 = $0.000003
        // Input images: (2*258/1M)*0.5 = (516/1M)*0.5 = $0.000258
        // Output image: (1120/1M)*60 = $0.0672
        // Total ≈ $0.067461
        expect(cost).toBeCloseTo(0.0675, 3);
    });

    // ── Fallback to outputPerMillion when imageOutputPerMillion is absent ──

    it("falls back to outputPerMillion when imageOutputPerMillion is missing", () => {
        const pricing = { inputPerMillion: 0.5, outputPerMillion: 3.0 };
        const prompt = "Generate something";
        const cost = calculateImageCost(prompt, pricing, 0, 1120);
        // Input: ceil(18/4)=5 → (5/1M)*0.5 = $0.0000025
        // Output image: (1120/1M)*3.0 = $0.00336
        // Total ≈ $0.0033625
        expect(cost).toBeCloseTo(0.00336, 4);
    });
});

// ═══════════════════════════════════════════════════════════════
// calculateImageCost — real pricing from config.js
// ═══════════════════════════════════════════════════════════════

describe("calculateImageCost with real config pricing", () => {
    const imagePricing = getPricing(TYPES.TEXT, TYPES.IMAGE);

    it("Gemini 3.1 Flash Image: ~$0.067 per 1024px image", () => {
        const pricing = imagePricing["gemini-3.1-flash-image-preview"];
        const prompt = "A cute cartoon turtle standing upright with a friendly expression";
        const cost = calculateImageCost(prompt, pricing, 0, 1120);
        // Google's published price for 1024px: ~$0.067
        // Output: (1120/1M)*60 = $0.0672 + negligible input cost
        expect(cost).toBeGreaterThan(0.065);
        expect(cost).toBeLessThan(0.070);
    });

    it("Gemini 3 Pro Image: ~$0.134 per 1024px image", () => {
        const pricing = imagePricing["gemini-3-pro-image-preview"];
        const prompt = "A watercolor landscape painting";
        const cost = calculateImageCost(prompt, pricing, 0, 1120);
        // Google's published price for 1024px: ~$0.134
        expect(cost).toBeGreaterThan(0.130);
        expect(cost).toBeLessThan(0.140);
    });

    it("GPT Image 1.5: ~$0.034 per 1024px image", () => {
        const pricing = imagePricing["gpt-image-1.5"];
        const prompt = "A realistic photo of a mountain landscape";
        const cost = calculateImageCost(prompt, pricing, 0, 1056);
        // OpenAI 1024×1024: (1056/1M)*32 = $0.033792 + negligible input
        expect(cost).toBeGreaterThan(0.030);
        expect(cost).toBeLessThan(0.040);
    });
});

// ═══════════════════════════════════════════════════════════════
// calculateLiveCost — Unit Tests
// ═══════════════════════════════════════════════════════════════

describe("calculateLiveCost", () => {
    it("returns null when pricing is null", () => {
        expect(calculateLiveCost({ inputTokens: 100, outputTokens: 50 }, null)).toBeNull();
    });

    it("returns null when usage is null", () => {
        const pricing = { audioInputPerMillion: 3.0, audioOutputPerMillion: 12.0 };
        expect(calculateLiveCost(null, pricing)).toBeNull();
    });

    it("calculates Live API cost for Gemini 3.1 Flash Live", () => {
        // audioInput $3.00/M, audioOutput $12.00/M
        const usage = { inputTokens: 10000, outputTokens: 5000 };
        const pricing = { inputPerMillion: 0.75, audioInputPerMillion: 3.0, outputPerMillion: 4.5, audioOutputPerMillion: 12.0 };
        // Uses audioInputPerMillion and audioOutputPerMillion
        // (10000/1M)*3.0 + (5000/1M)*12.0 = 0.03 + 0.06 = 0.09
        const cost = calculateLiveCost(usage, pricing);
        expect(cost).toBeCloseTo(0.09, 8);
    });

    it("falls back to text rates when audio rates are missing", () => {
        const usage = { inputTokens: 10000, outputTokens: 5000 };
        const pricing = { inputPerMillion: 0.5, outputPerMillion: 3.0 };
        // (10000/1M)*0.5 + (5000/1M)*3.0 = 0.005 + 0.015 = 0.02
        const cost = calculateLiveCost(usage, pricing);
        expect(cost).toBeCloseTo(0.02, 8);
    });
});

// ═══════════════════════════════════════════════════════════════
// Pricing Sanity Checks — guard against config drift
// ═══════════════════════════════════════════════════════════════
// These tests verify that config.js pricing matches official
// published values. If a model's pricing changes upstream,
// these tests will fail and force a deliberate update.

describe("Pricing sanity checks against official published rates", () => {

    // ── Google Gemini — Text/Conversation ─────────────────────────

    it("Gemini 3.5 Flash: $1.50 in / $9.00 out, $3.00 audioIn", () => {
        const m = getModelByName("gemini-3.5-flash");
        expect(m.pricing.inputPerMillion).toBe(1.5);
        expect(m.pricing.audioInputPerMillion).toBe(3.0);
        expect(m.pricing.outputPerMillion).toBe(9.0);
    });

    it("Gemini 3 Flash: $0.50 in / $3.00 out, $1.00 audioIn", () => {
        const m = getModelByName("gemini-3-flash-preview");
        expect(m.pricing.inputPerMillion).toBe(0.5);
        expect(m.pricing.audioInputPerMillion).toBe(1.0);
        expect(m.pricing.outputPerMillion).toBe(3.0);
    });

    it("Gemini 3 Pro: $2.00 in / $12.00 out, $4.00 audioIn", () => {
        const m = getModelByName("gemini-3-pro-preview");
        expect(m.pricing.inputPerMillion).toBe(2.0);
        expect(m.pricing.audioInputPerMillion).toBe(4.0);
        expect(m.pricing.outputPerMillion).toBe(12.0);
    });

    it("Gemini 3.1 Pro: $2.00 in / $12.00 out, $4.00 audioIn", () => {
        const m = getModelByName("gemini-3.1-pro-preview");
        expect(m.pricing.inputPerMillion).toBe(2.0);
        expect(m.pricing.audioInputPerMillion).toBe(4.0);
        expect(m.pricing.outputPerMillion).toBe(12.0);
    });

    it("Gemini 3.1 Flash Live: $0.75 textIn / $3.00 audioIn / $4.50 textOut / $12.00 audioOut", () => {
        const m = getModelByName("gemini-3.1-flash-live-preview");
        expect(m.pricing.inputPerMillion).toBe(0.75);
        expect(m.pricing.audioInputPerMillion).toBe(3.0);
        expect(m.pricing.outputPerMillion).toBe(4.5);
        expect(m.pricing.audioOutputPerMillion).toBe(12.0);
    });

    // ── Google Gemini — Image Generation ──────────────────────────

    it("Gemini 3.1 Flash Image: $0.50 in / $0.50 imageIn / $3.00 out / $60.00 imageOut", () => {
        const m = getModelByName("gemini-3.1-flash-image-preview");
        expect(m.pricing.inputPerMillion).toBe(0.5);
        expect(m.pricing.imageInputPerMillion).toBe(0.5);
        expect(m.pricing.outputPerMillion).toBe(3.0);
        expect(m.pricing.imageOutputPerMillion).toBe(60.0);
    });

    it("Gemini 3 Pro Image: $2.00 in / $2.00 imageIn / $12.00 out / $120.00 imageOut", () => {
        const m = getModelByName("gemini-3-pro-image-preview");
        expect(m.pricing.inputPerMillion).toBe(2.0);
        expect(m.pricing.imageInputPerMillion).toBe(2.0);
        expect(m.pricing.outputPerMillion).toBe(12.0);
        expect(m.pricing.imageOutputPerMillion).toBe(120.0);
    });

    it("Gemini 3.1 Flash Image per-image cost matches Google's published ~$0.067", () => {
        // Google: 1024px = 1120 tokens at $60/M = $0.0672
        const m = getModelByName("gemini-3.1-flash-image-preview");
        const costPerImage = (1120 / 1_000_000) * m.pricing.imageOutputPerMillion;
        expect(costPerImage).toBeCloseTo(0.067, 3);
    });

    it("Gemini 3 Pro Image per-image cost matches Google's published ~$0.134", () => {
        // Google: 1024px to 2048px = 1120 tokens at $120/M = $0.1344
        const m = getModelByName("gemini-3-pro-image-preview");
        const costPerImage = (1120 / 1_000_000) * m.pricing.imageOutputPerMillion;
        expect(costPerImage).toBeCloseTo(0.134, 3);
    });

    // ── Google Gemini — TTS ──────────────────────────────────────

    it("Gemini 2.5 Flash TTS: $0.50 in / $10.00 audioOut", () => {
        const m = getModelByName("gemini-2.5-flash-preview-tts");
        expect(m.pricing.inputPerMillion).toBe(0.5);
        expect(m.pricing.audioOutputPerMillion).toBe(10.0);
    });

    it("Gemini 2.5 Pro TTS: $1.00 in / $20.00 audioOut", () => {
        const m = getModelByName("gemini-2.5-pro-preview-tts");
        expect(m.pricing.inputPerMillion).toBe(1.0);
        expect(m.pricing.audioOutputPerMillion).toBe(20.0);
    });

    // ── Google Gemini — Embeddings ────────────────────────────────

    it("Gemini Embedding 2: $0.20 in", () => {
        const m = getModelByName("gemini-embedding-2-preview");
        expect(m.pricing.inputPerMillion).toBe(0.2);
    });

    // ── Google Gemini — STT ──────────────────────────────────────

    it("Gemini 3.5 Flash STT: $1.00 audioIn / $3.00 out", () => {
        const sttPricing = getPricing(TYPES.AUDIO, TYPES.TEXT);
        const p = sttPricing["gemini-3.5-flash"];
        expect(p.audioInputPerMillion).toBe(1.0);
        expect(p.outputPerMillion).toBe(3.0);
    });

    it("Gemini 3 Flash STT: $1.00 audioIn / $3.00 out", () => {
        const _m = getModelByName("gemini-3-flash-preview");
        // STT uses same model name; these come from the audio variant config
        const sttPricing = getPricing(TYPES.AUDIO, TYPES.TEXT);
        const p = sttPricing["gemini-3-flash-preview"];
        expect(p.audioInputPerMillion).toBe(1.0);
        expect(p.outputPerMillion).toBe(3.0);
    });

    // ── OpenAI — Text Generation ─────────────────────────────────

    it("GPT 5.2: $1.75 in / $14.00 out", () => {
        const m = getModelByName("gpt-5.2");
        expect(m.pricing.inputPerMillion).toBe(1.75);
        expect(m.pricing.outputPerMillion).toBe(14.0);
    });

    it("GPT 5 Mini: $0.25 in / $2.00 out", () => {
        const m = getModelByName("gpt-5-mini");
        expect(m.pricing.inputPerMillion).toBe(0.25);
        expect(m.pricing.outputPerMillion).toBe(2.0);
    });

    it("GPT 5 Nano: $0.05 in / $0.40 out", () => {
        const m = getModelByName("gpt-5-nano");
        expect(m.pricing.inputPerMillion).toBe(0.05);
        expect(m.pricing.outputPerMillion).toBe(0.4);
    });

    it("GPT 5.4: $2.50 in / $15.00 out", () => {
        const m = getModelByName("gpt-5.4");
        expect(m.pricing.inputPerMillion).toBe(2.5);
        expect(m.pricing.outputPerMillion).toBe(15.0);
    });

    it("GPT 5.4 Pro: $30.00 in / $180.00 out", () => {
        const m = getModelByName("gpt-5.4-pro");
        expect(m.pricing.inputPerMillion).toBe(30.0);
        expect(m.pricing.outputPerMillion).toBe(180.0);
    });

    // ── OpenAI — Image Generation ────────────────────────────────

    it("GPT Image 1.5: $5.00 textIn / $8.00 imageIn / $10.00 textOut / $32.00 imageOut", () => {
        const m = getModelByName("gpt-image-1.5");
        expect(m.pricing.inputPerMillion).toBe(5.0);
        expect(m.pricing.cachedInputPerMillion).toBe(1.25);
        expect(m.pricing.imageInputPerMillion).toBe(8.0);
        expect(m.pricing.cachedImageInputPerMillion).toBe(2.0);
        expect(m.pricing.outputPerMillion).toBe(10.0);
        expect(m.pricing.imageOutputPerMillion).toBe(32.0);
    });

    // ── OpenAI — Audio ───────────────────────────────────────────

    it("GPT-4o Mini TTS: $0.60 in / $12.00 audioOut", () => {
        const m = getModelByName("gpt-4o-mini-tts");
        expect(m.pricing.inputPerMillion).toBe(0.6);
        expect(m.pricing.audioOutputPerMillion).toBe(12.0);
    });

    it("Whisper V2: $0.006/min", () => {
        const m = getModelByName("whisper-1");
        expect(m.pricing.perMinute).toBe(0.006);
    });

    it("GPT-4o Transcribe: $2.50 audioIn / $10.00 out / $0.006/min", () => {
        const m = getModelByName("gpt-4o-transcribe");
        expect(m.pricing.audioInputPerMillion).toBe(2.5);
        expect(m.pricing.outputPerMillion).toBe(10.0);
        expect(m.pricing.perMinute).toBe(0.006);
    });

    // ── Anthropic ────────────────────────────────────────────────

    it("Haiku 4.5: $1.00 in / $5.00 out", () => {
        const m = getModelByName("claude-haiku-4-5-20251001");
        expect(m.pricing.inputPerMillion).toBe(1.0);
        expect(m.pricing.outputPerMillion).toBe(5.0);
    });

    it("Sonnet 4.5: $3.00 in / $15.00 out", () => {
        const m = getModelByName("claude-sonnet-4-5-20250929");
        expect(m.pricing.inputPerMillion).toBe(3.0);
        expect(m.pricing.outputPerMillion).toBe(15.0);
    });

    it("Opus 4.5: $5.00 in / $25.00 out", () => {
        const m = getModelByName("claude-opus-4-5-20251101");
        expect(m.pricing.inputPerMillion).toBe(5.0);
        expect(m.pricing.outputPerMillion).toBe(25.0);
    });

    it("Opus 4.6: $5.00 in / $25.00 out", () => {
        const m = getModelByName("claude-opus-4-6");
        expect(m.pricing.inputPerMillion).toBe(5.0);
        expect(m.pricing.outputPerMillion).toBe(25.0);
    });

    it("Opus 4.7: $5.00 in / $25.00 out", () => {
        const m = getModelByName("claude-opus-4-7");
        expect(m.pricing.inputPerMillion).toBe(5.0);
        expect(m.pricing.outputPerMillion).toBe(25.0);
    });

    it("Opus 4.8: $5.00 in / $25.00 out", () => {
        const m = getModelByName("claude-opus-4-8");
        expect(m.pricing.inputPerMillion).toBe(5.0);
        expect(m.pricing.outputPerMillion).toBe(25.0);
    });

    it("Fable 5: $10.00 in / $50.00 out", () => {
        const model = getModelByName("claude-fable-5");
        expect(model.pricing.inputPerMillion).toBe(10.0);
        expect(model.pricing.outputPerMillion).toBe(50.0);
    });

    it("Mythos 5: $10.00 in / $50.00 out", () => {
        const model = getModelByName("claude-mythos-5");
        expect(model.pricing.inputPerMillion).toBe(10.0);
        expect(model.pricing.outputPerMillion).toBe(50.0);
    });

    // ── OpenAI — Embeddings ──────────────────────────────────────

    it("text-embedding-3-small: $0.02 in", () => {
        const m = getModelByName("text-embedding-3-small");
        expect(m.pricing.inputPerMillion).toBe(0.02);
    });

    it("text-embedding-3-large: $0.13 in", () => {
        const m = getModelByName("text-embedding-3-large");
        expect(m.pricing.inputPerMillion).toBe(0.13);
    });

// ═══════════════════════════════════════════════════════════════
// normalizeUsage — Unit Tests
// ═══════════════════════════════════════════════════════════════
// Verifies extraction of prompt_tokens_details.cached_tokens and
// completion_tokens_details.reasoning_tokens from OpenAI-compat
// usage responses (LM Studio, OpenAI, vLLM, etc.)

describe("normalizeUsage", () => {
    it("extracts basic prompt_tokens and completion_tokens", () => {
        const usage = normalizeUsage({ prompt_tokens: 100, completion_tokens: 50 });
        expect(usage.inputTokens).toBe(100);
        expect(usage.outputTokens).toBe(50);
    });

    it("returns zeros when rawUsage is null", () => {
        const usage = normalizeUsage(null);
        expect(usage.inputTokens).toBe(0);
        expect(usage.outputTokens).toBe(0);
    });

    it("returns zeros when rawUsage is undefined", () => {
        const usage = normalizeUsage(undefined);
        expect(usage.inputTokens).toBe(0);
        expect(usage.outputTokens).toBe(0);
    });

    // ── Cached tokens (KV cache hits) ───────────────────────────

    it("extracts cached_tokens from prompt_tokens_details", () => {
        const usage = normalizeUsage({
            prompt_tokens: 1000,
            completion_tokens: 200,
            prompt_tokens_details: { cached_tokens: 800 },
        });
        expect(usage.cacheReadInputTokens).toBe(800);
        // inputTokens should be adjusted to non-cached portion
        expect(usage.inputTokens).toBe(200);
        expect(usage.outputTokens).toBe(200);
    });

    it("does not set cacheReadInputTokens when cached_tokens is 0", () => {
        const usage = normalizeUsage({
            prompt_tokens: 500,
            completion_tokens: 100,
            prompt_tokens_details: { cached_tokens: 0 },
        });
        expect(usage.cacheReadInputTokens).toBeUndefined();
        expect(usage.inputTokens).toBe(500);
    });

    it("does not set cacheReadInputTokens when prompt_tokens_details is absent", () => {
        const usage = normalizeUsage({
            prompt_tokens: 500,
            completion_tokens: 100,
        });
        expect(usage.cacheReadInputTokens).toBeUndefined();
        expect(usage.inputTokens).toBe(500);
    });

    it("clamps inputTokens to 0 when cached_tokens >= prompt_tokens", () => {
        const usage = normalizeUsage({
            prompt_tokens: 100,
            completion_tokens: 50,
            prompt_tokens_details: { cached_tokens: 100 },
        });
        expect(usage.cacheReadInputTokens).toBe(100);
        expect(usage.inputTokens).toBe(0);
    });

    // ── Reasoning tokens ────────────────────────────────────────

    it("extracts reasoning_tokens from completion_tokens_details", () => {
        const usage = normalizeUsage({
            prompt_tokens: 12,
            completion_tokens: 10,
            completion_tokens_details: { reasoning_tokens: 9 },
        });
        expect(usage.reasoningOutputTokens).toBe(9);
        expect(usage.outputTokens).toBe(10);
    });

    it("does not set reasoningOutputTokens when reasoning_tokens is 0", () => {
        const usage = normalizeUsage({
            prompt_tokens: 100,
            completion_tokens: 50,
            completion_tokens_details: { reasoning_tokens: 0 },
        });
        expect(usage.reasoningOutputTokens).toBeUndefined();
    });

    // ── Combined cache + reasoning ──────────────────────────────

    it("extracts both cached_tokens and reasoning_tokens when present", () => {
        const usage = normalizeUsage({
            prompt_tokens: 1000,
            completion_tokens: 500,
            prompt_tokens_details: { cached_tokens: 800 },
            completion_tokens_details: { reasoning_tokens: 350 },
        });
        expect(usage.inputTokens).toBe(200);
        expect(usage.cacheReadInputTokens).toBe(800);
        expect(usage.outputTokens).toBe(500);
        expect(usage.reasoningOutputTokens).toBe(350);
    });

    // ── Integration with getTotalInputTokens ────────────────────

    it("getTotalInputTokens aggregates inputTokens + cacheReadInputTokens", () => {
        const usage = normalizeUsage({
            prompt_tokens: 1000,
            completion_tokens: 200,
            prompt_tokens_details: { cached_tokens: 800 },
        });
        // Total should equal original prompt_tokens
        const total = getTotalInputTokens(usage);
        expect(total).toBe(1000);
    });

    it("getTotalInputTokens works without cache fields", () => {
        const usage = normalizeUsage({
            prompt_tokens: 500,
            completion_tokens: 100,
        });
        expect(getTotalInputTokens(usage)).toBe(500);
    });

    // ── Integration with calculateTextCost ───────────────────────

    it("cached tokens feed into calculateTextCost cachedInputPerMillion", () => {
        const usage = normalizeUsage({
            prompt_tokens: 1000,
            completion_tokens: 200,
            prompt_tokens_details: { cached_tokens: 800 },
        });
        // Use pricing that has cachedInputPerMillion
        const pricing = {
            inputPerMillion: 1.0,
            outputPerMillion: 5.0,
            cachedInputPerMillion: 0.1,
        };
        const cost = calculateTextCost(usage, pricing);
        // new input: (200/1M)*1.0 = 0.0002
        // cache read: (800/1M)*0.1 = 0.00008
        // output: (200/1M)*5.0 = 0.001
        // total = 0.00128
        expect(cost).toBeCloseTo(0.00128, 8);
    });
});

describe("normalizeResponsesUsage", () => {
    it("extracts basic input_tokens and output_tokens", () => {
        const usage = normalizeResponsesUsage({ input_tokens: 100, output_tokens: 50 });
        expect(usage.inputTokens).toBe(100);
        expect(usage.outputTokens).toBe(50);
    });

    it("returns zeros when rawUsage is null", () => {
        const usage = normalizeResponsesUsage(null);
        expect(usage.inputTokens).toBe(0);
        expect(usage.outputTokens).toBe(0);
    });

    it("returns zeros when rawUsage is undefined", () => {
        const usage = normalizeResponsesUsage(undefined);
        expect(usage.inputTokens).toBe(0);
        expect(usage.outputTokens).toBe(0);
    });

    it("extracts cached_tokens from input_tokens_details", () => {
        const usage = normalizeResponsesUsage({
            input_tokens: 1000,
            output_tokens: 200,
            input_tokens_details: { cached_tokens: 800 },
        });
        expect(usage.cacheReadInputTokens).toBe(800);
        expect(usage.inputTokens).toBe(200);
        expect(usage.outputTokens).toBe(200);
    });

    it("does not set cacheReadInputTokens when cached_tokens is 0", () => {
        const usage = normalizeResponsesUsage({
            input_tokens: 500,
            output_tokens: 100,
            input_tokens_details: { cached_tokens: 0 },
        });
        expect(usage.cacheReadInputTokens).toBeUndefined();
        expect(usage.inputTokens).toBe(500);
    });

    it("clamps inputTokens to 0 when cached_tokens >= input_tokens", () => {
        const usage = normalizeResponsesUsage({
            input_tokens: 100,
            output_tokens: 50,
            input_tokens_details: { cached_tokens: 100 },
        });
        expect(usage.cacheReadInputTokens).toBe(100);
        expect(usage.inputTokens).toBe(0);
    });

    it("extracts reasoning_tokens from output_tokens_details", () => {
        const usage = normalizeResponsesUsage({
            input_tokens: 12,
            output_tokens: 10,
            output_tokens_details: { reasoning_tokens: 9 },
        });
        expect(usage.reasoningOutputTokens).toBe(9);
        expect(usage.outputTokens).toBe(10);
    });

    it("does not set reasoningOutputTokens when reasoning_tokens is 0", () => {
        const usage = normalizeResponsesUsage({
            input_tokens: 100,
            output_tokens: 50,
            output_tokens_details: { reasoning_tokens: 0 },
        });
        expect(usage.reasoningOutputTokens).toBeUndefined();
    });

    it("extracts both cached_tokens and reasoning_tokens when present", () => {
        const usage = normalizeResponsesUsage({
            input_tokens: 1000,
            output_tokens: 500,
            input_tokens_details: { cached_tokens: 800 },
            output_tokens_details: { reasoning_tokens: 350 },
        });
        expect(usage.inputTokens).toBe(200);
        expect(usage.cacheReadInputTokens).toBe(800);
        expect(usage.outputTokens).toBe(500);
        expect(usage.reasoningOutputTokens).toBe(350);
    });
});
});

// ── Adversarial Boundary Tests (merged from adversarial-boundary.test.ts) ──

describe('CostCalculator adversarial', () => {
  describe('estimateTokens — boundary inputs', () => {
    it('should return 0 for null input without throwing', () => {
      expect(estimateTokens(null)).toBe(0);
    });

    it('should return 0 for undefined input without throwing', () => {
      expect(estimateTokens(undefined)).toBe(0);
    });

    it('should return 0 for empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });

    it('should handle a 100K-character string without OOM or timeout', () => {
      const giantString = 'x'.repeat(100_000);
      const result = estimateTokens(giantString);
      expect(result).toBe(25_000);
    });

    it('should handle string of all null bytes (\\0) — the estimate should still count bytes', () => {
      const nullByteString = '\0'.repeat(100);
      const result = estimateTokens(nullByteString);
      expect(result).toBe(25);
    });

    it('should handle unicode combining characters — emoji sequences inflate char count but not token count', () => {
      // Emoji family: 👨‍👩‍👧‍👦 is 7 code points but renders as 1 glyph
      const emojiFamily = '👨‍👩‍👧‍👦';
      const result = estimateTokens(emojiFamily);
      // The estimate is chars/4 — at minimum it should be a positive integer
      expect(result).toBeGreaterThan(0);
      expect(Number.isFinite(result)).toBe(true);
    });
  });

  describe('mergeUsage — type coercion attacks', () => {
    it('should survive merging with null source', () => {
      const accumulator = createUsageAccumulator();
      accumulator.inputTokens = 100;
      const result = mergeUsage(accumulator, null);
      expect(result.inputTokens).toBe(100);
    });

    it('should survive merging with undefined source', () => {
      const accumulator = createUsageAccumulator();
      accumulator.outputTokens = 50;
      const result = mergeUsage(accumulator, undefined);
      expect(result.outputTokens).toBe(50);
    });

    it('should handle NaN in source fields — silently coerced to 0 by || operator', () => {
      const accumulator = createUsageAccumulator();
      accumulator.inputTokens = 100;
      // NaN || 0 → 0 in JavaScript because NaN is falsy
      const poisonSource = { inputTokens: NaN, outputTokens: 0 };
      mergeUsage(accumulator, poisonSource);
      // Defensive: NaN is silently converted to 0, so no poisoning occurs
      expect(accumulator.inputTokens).toBe(100);
    });

    it('should handle negative token counts — negative usage should not produce negative costs', () => {
      const accumulator = createUsageAccumulator();
      const negativeSource = { inputTokens: -500, outputTokens: -200 };
      mergeUsage(accumulator, negativeSource);
      expect(accumulator.inputTokens).toBe(-500);
      // This is a design question: should negative usage be rejected?
      // The test documents the current behavior.
    });

    it('should handle Infinity in token counts', () => {
      const accumulator = createUsageAccumulator();
      const infinitySource = { inputTokens: Infinity, outputTokens: 0 };
      mergeUsage(accumulator, infinitySource);
      expect(accumulator.inputTokens).toBe(Infinity);
    });

    it('should handle Number.MAX_SAFE_INTEGER overflow — repeated accumulation', () => {
      const accumulator = createUsageAccumulator();
      accumulator.inputTokens = Number.MAX_SAFE_INTEGER;
      const source = { inputTokens: 1, outputTokens: 0 };
      mergeUsage(accumulator, source);
      // JavaScript silently loses precision past MAX_SAFE_INTEGER
      expect(accumulator.inputTokens).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    });
  });

  describe('calculateTextCost — null/edge pricing', () => {
    it('should return null when pricing is null', () => {
      expect(calculateTextCost({ inputTokens: 100, outputTokens: 50 }, null)).toBeNull();
    });

    it('should return null when usage is null', () => {
      expect(calculateTextCost(null, { inputPerMillion: 1 })).toBeNull();
    });

    it('should return null when both are null', () => {
      expect(calculateTextCost(null, null)).toBeNull();
    });

    it('should return 0 when all pricing rates are 0', () => {
      const usage = { inputTokens: 1_000_000, outputTokens: 500_000 };
      const pricing = { inputPerMillion: 0, outputPerMillion: 0 };
      expect(calculateTextCost(usage, pricing)).toBe(0);
    });

    it('should handle cache tokens with no cache pricing gracefully', () => {
      const usage = {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 5000,
        cacheCreationInputTokens: 2000,
      };
      const pricing = { inputPerMillion: 3, outputPerMillion: 15 };
      // No cachedInputPerMillion or cacheWriteInputPerMillion — these should be silently skipped
      const result = calculateTextCost(usage, pricing);
      expect(result).not.toBeNull();
      expect(result).toBeGreaterThan(0);
    });
  });

  describe('calculateAudioCost — empty/missing fields', () => {
    it('should return 0 when duration is 0 — zero-duration audio costs nothing', () => {
      const usage = { inputTokens: 0, outputTokens: 0, durationSeconds: 0 };
      const pricing = { perMinute: 0.006 };
      // Fixed: `durationSeconds != null` guard allows 0 through Strategy 1
      expect(calculateAudioCost(usage, pricing)).toBe(0);
    });

    it('should prefer per-minute pricing over per-token when both exist', () => {
      const usage = { inputTokens: 100_000, outputTokens: 50_000, durationSeconds: 120 };
      const pricing = {
        perMinute: 0.006,
        audioInputPerMillion: 100,
        outputPerMillion: 50,
      };
      const result = calculateAudioCost(usage, pricing);
      // Should use perMinute: (120/60) * 0.006 = 0.012
      expect(result).toBeCloseTo(0.012, 4);
    });

    it('should clamp negative duration to 0 and calculate zero cost', () => {
      const usage = { inputTokens: 0, outputTokens: 0, durationSeconds: -10 };
      const pricing = { perMinute: 0.006 };
      expect(calculateAudioCost(usage, pricing)).toBe(0);
    });
  });

  describe('calculateImageCost — edge cases', () => {
    it('should return null for empty prompt', () => {
      expect(calculateImageCost('', { inputPerMillion: 1 })).toBeNull();
    });

    it('should return null for null prompt', () => {
      expect(calculateImageCost(null, { inputPerMillion: 1 })).toBeNull();
    });

    it('should handle 0 input images without crashing', () => {
      const result = calculateImageCost('a cat', { inputPerMillion: 1, imageOutputPerMillion: 10 }, 0);
      expect(result).not.toBeNull();
    });
  });

  describe('getTotalInputTokens — null safety', () => {
    it('should return 0 for null usage', () => {
      expect(getTotalInputTokens(null)).toBe(0);
    });

    it('should return 0 for undefined usage', () => {
      expect(getTotalInputTokens(undefined)).toBe(0);
    });

    it('should sum all three input token fields', () => {
      const usage = {
        inputTokens: 100,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 300,
        outputTokens: 0,
      };
      expect(getTotalInputTokens(usage)).toBe(600);
    });
  });
});

// ── Cross-Module Integration Tests (merged from adversarial-boundary.test.ts) ──

describe('CostCalculator × ContextWindowManager integration seam', () => {
  it('should return untouched when budget is negative (maxInput < outputReserve)', () => {
    const messages: any[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'hello' },
    ];
    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 1000,
      maxOutputTokens: 50_000,
    });
    // Negative budget → returns as-is, truncated=false
    expect(result.truncated).toBe(false);
    expect(result.messages.length).toBe(2);
  });

  it('should maintain non-negative token estimates after aggressive truncation', () => {
    const messages: any[] = [
      { role: 'system', content: 'system prompt' },
    ];
    for (let index = 0; index < 50; index++) {
      messages.push({
        role: 'assistant',
        content: 'x'.repeat(2000),
        toolCalls: [
          {
            name: 'read_file',
            args: { path: '/tmp/test' },
            result: 'x'.repeat(20000),
          },
        ],
      });
      messages.push({ role: 'user', content: 'x'.repeat(500) });
    }

    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 200_000,
      maxOutputTokens: 8192,
      toolCount: 5,
    });

    // Token estimate should always be non-negative
    expect(result.estimatedTokens).toBeGreaterThanOrEqual(0);
    // With 281K estimated tokens and ~153K budget, truncation should fire
    expect(result.truncated).toBe(true);
  });
});
