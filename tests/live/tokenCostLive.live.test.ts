/**
 * Live Token/Cost Accuracy Tests
 * ═══════════════════════════════════════════════════════════
 * Hits the RUNNING Prism server at localhost:7777 with real
 * provider API calls. Validates that:
 *   - Token counts are non-zero and plausible
 *   - Estimated costs are positive and in expected ranges
 *   - Usage fields (input, output, cache) are present
 *   - Function calling inflates input tokens correctly
 *
 * Run:  npm run test:live
 *
 * Uses the cheapest model per provider:
 *   • OpenAI:    gpt-5-nano          ($0.025 / $0.20 per M)
 *   • Anthropic: claude-haiku-4-5    ($1.00 / $5.00 per M)
 *   • Google:    gemini-3-flash      ($0.50 / $3.00 per M)
 *   • LM Studio: whatever is loaded  ($0.00 / $0.00)
 *
 * Total cost per full run: ~$0.001–$0.01
 * ═══════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeAll } from "vitest";
import { PROVIDERS } from "../../src/constants.ts";
import { calculateTextCost } from "../../src/utils/CostCalculator.ts";
import { TYPES, getPricing } from "../../src/config.ts";

const PRISM_SERVICE_URL = "http://localhost:7777";
const TEXT_PRICING = getPricing(TYPES.TEXT, TYPES.TEXT);
const SIMPLE_PROMPT = "Reply with exactly one word: hello.";

// ── 10 real tool definitions from tools.rod.dev ────────
// Sourced from GET /admin/tool-schemas — covers Weather,
// Events, Markets, Finance, Knowledge, Health, Transit, Utilities.
const SAMPLE_TOOLS = [
  {
    name: "get_current_weather",
    description:
      "Get current weather conditions including temperature, humidity, wind, UV index, feels-like temperature, precipitation, and air quality indicators.",
    parameters: {
      type: "object",
      properties: {
        fields: {
          type: "string",
          description:
            "Comma-separated list of fields to return. Available: temperature, apparentTemperature, humidity, weatherCode, weatherDescription, cloudCover, precipitation, rain, showers, snowfall, windSpeed, windDirection, windGust, pressure, isDay, uvIndex, sunrise, sunset, daylightDuration, usAqi, europeanAqi, pm25, pm10, ozone, carbonMonoxide, nitrogenDioxide, dust",
        },
      },
      required: ["fields"],
    },
  },
  {
    name: "get_earthquakes",
    description:
      "Get recent earthquake data. Each earthquake includes magnitude, location, depth, time, and alert level.",
    parameters: {
      type: "object",
      properties: {
        fields: {
          type: "string",
          description:
            "Comma-separated list of fields to return. Available: usgsId, magnitude, magnitudeType, magnitudeClass, place, time, url, felt, alert, tsunami, significance, title, latitude, longitude, depth",
        },
      },
      required: ["fields"],
    },
  },
  {
    name: "search_events",
    description:
      "Search for local events including concerts, sports games, festivals, community gatherings, and movie releases. Can filter by source, category, and text search.",
    parameters: {
      type: "object",
      properties: {
        q: {
          type: "string",
          description: "Text search query for event names or descriptions",
        },
        source: {
          type: "string",
          description:
            "Filter by event source (e.g. ticketmaster, seatgeek, craigslist, ubc, sfu, city_of_vancouver, nhl, whitecaps, bc_lions, tmdb, google_places)",
        },
        category: {
          type: "string",
          description:
            "Filter by event category (music, sports, arts, comedy, family, film, food, tech, other)",
        },
        limit: {
          type: "number",
          description: "Maximum number of events to return (default: 20)",
        },
        fields: {
          type: "string",
          description:
            "Comma-separated list of fields to return. Available: name, description, source, category, startDate, endDate, url, imageUrl, status, genres, priceRange.min, priceRange.max, priceRange.currency, venue.name, venue.address, venue.city, venue.state, venue.country, venue.latitude, venue.longitude, mapImageUrl",
        },
      },
      required: ["fields"],
    },
  },
  {
    name: "get_commodity_ticker",
    description:
      "Get detailed data for a specific commodity/market ticker symbol.",
    parameters: {
      type: "object",
      properties: {
        ticker: {
          type: "string",
          description:
            "Ticker symbol (e.g. CL=F for crude oil, GC=F for gold, SI=F for silver, BTC-USD for Bitcoin, ^GSPC for S&P 500)",
        },
        fields: {
          type: "string",
          description:
            "Comma-separated list of fields to return. Available: ticker, name, price, change, changePercent, category, unit, dayHigh, dayLow, previousClose, volume",
        },
      },
      required: ["ticker", "fields"],
    },
  },
  {
    name: "get_stock_quote",
    description:
      "Get real-time stock quote. Fields: c=current price, d=change, dp=percent change, h=day high, l=day low, o=open, pc=previous close, t=timestamp.",
    parameters: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Stock ticker symbol (e.g. AAPL, MSFT, GOOGL)",
        },
        fields: {
          type: "string",
          description:
            "Comma-separated list of fields to return. Available: symbol, c, d, dp, h, l, o, pc, t, cached",
        },
      },
      required: ["symbol", "fields"],
    },
  },
  {
    name: "get_wikipedia_summary",
    description:
      "Get a summary of any Wikipedia article including extract text, thumbnail image, description, and page URL. Good for quick factual lookups.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            "Wikipedia article title (e.g. 'Albert Einstein', 'Machine learning')",
        },
        fields: {
          type: "string",
          description:
            "Comma-separated list of fields to return. Available: found, title, displayTitle, extract, description, thumbnail, originalImage, pageUrl, lastModified",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "search_usda_nutrition",
    description:
      "Search USDA's curated database of ~1,346 raw whole foods for detailed nutritional information. Returns per-100g nutrient values including macros, minerals, vitamins, amino acids, lipid profiles, and more.",
    parameters: {
      type: "object",
      properties: {
        q: {
          type: "string",
          description:
            "Food name to search (e.g. 'chicken', 'spinach', 'salmon', 'almond')",
        },
        limit: { type: "number", description: "Max results (default: 10)" },
        kingdom: {
          type: "string",
          description:
            "Filter by biological kingdom: animalia, plantae, or fungi",
          enum: ["animalia", "plantae", "fungi"],
        },
        foodType: {
          type: "string",
          description: "Filter by food type: animal, plant, or fungus",
        },
        nutrientTypes: {
          type: "string",
          description:
            "Comma-separated nutrient categories to include: macros, minerals, vitamins, amino_acids, lipids, carbs, sterols. Omit for all.",
        },
        fields: {
          type: "string",
          description:
            "Comma-separated list of fields to return. Available: name, description, kingdom, foodType, foodSubtype, part, form, state, taxonomy.taxon, taxonomy.kingdom, taxonomy.phylum, taxonomy.class, taxonomy.order, taxonomy.suborder, taxonomy.family, taxonomy.subfamily, taxonomy.tribe, taxonomy.genus, taxonomy.species, taxonomy.subspecies, taxonomy.variety, taxonomy.form, taxonomy.group, taxonomy.cultivar, taxonomy.phenotype, taxonomy.binomial, taxonomy.nomial, taxonomy.trinomial, perHundredGrams.macros, perHundredGrams.minerals, perHundredGrams.vitamins, perHundredGrams.aminoAcids, perHundredGrams.lipidProfile, perHundredGrams.carbDetails, perHundredGrams.sterols",
        },
      },
      required: ["q"],
    },
  },
  {
    name: "get_next_bus",
    description:
      "Get real-time bus arrival estimates for a TransLink (Vancouver) bus stop. Shows route, direction, expected arrival time, countdown, schedule status, and whether the trip is cancelled.",
    parameters: {
      type: "object",
      properties: {
        stopNo: {
          type: "number",
          description: "5-digit TransLink bus stop number (e.g. 51479)",
        },
        route: {
          type: "string",
          description: "Optional route number filter (e.g. '99', '014')",
        },
        fields: {
          type: "string",
          description:
            "Comma-separated list of fields to return. Available: stopNo, count, routes",
        },
      },
      required: ["stopNo"],
    },
  },
  {
    name: "convert_currency",
    description:
      "Convert an amount between any two currencies using real-time exchange rates. Supports 161 currencies including USD, CAD, EUR, GBP, JPY, etc.",
    parameters: {
      type: "object",
      properties: {
        amount: {
          type: "number",
          description: "Amount to convert (default: 1)",
        },
        from: {
          type: "string",
          description: "Source currency code (e.g. 'USD', 'CAD', 'EUR')",
        },
        to: {
          type: "string",
          description: "Target currency code (e.g. 'CAD', 'JPY', 'GBP')",
        },
        fields: {
          type: "string",
          description:
            "Comma-separated list of fields to return. Available: from, to, amount, rate, converted, lastUpdate",
        },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "search_papers",
    description:
      "Search academic papers on arXiv. Returns titles, abstracts, authors, publication dates, PDF links, and category classifications. Covers CS, physics, math, biology, economics, and more.",
    parameters: {
      type: "object",
      properties: {
        q: {
          type: "string",
          description: "Search query for paper titles/abstracts",
        },
        category: {
          type: "string",
          description:
            "arXiv category filter (e.g. cs.AI, cs.LG, cs.CL, cs.CV, cs.SE, physics, math, econ, stat)",
        },
        limit: {
          type: "number",
          description: "Max results (default: 10, max: 30)",
        },
        sortBy: {
          type: "string",
          description:
            "Sort order: relevance, lastUpdatedDate, submittedDate",
          enum: ["relevance", "lastUpdatedDate", "submittedDate"],
        },
        fields: {
          type: "string",
          description:
            "Comma-separated list of fields to return. Available: arxivId, title, abstract, authors, published, updated, primaryCategory, categories, pdfUrl, abstractUrl, doi, comment",
        },
      },
      required: ["q"],
    },
  },
];

// ── Helpers ──────────────────────────────────────────────────

async function chat(payload) {
  const res = await fetch(`${PRISM_SERVICE_URL}/chat?stream=false`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-project": "prism-live-tests",
      "x-username": "test-runner",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Prism returned ${res.status}: ${body}`);
  }
  return res.json();
}

async function isProviderAvailable(provider, model) {
  try {
    const res = await chat({
      provider,
      model,
      messages: [{ role: "user", content: "Say ok" }],
      maxTokens: 5,
    });
    return res.usage && typeof res.usage.inputTokens === "number";
  } catch {
    return false;
  }
}

async function isLmStudioAvailable() {
  try {
    const res = await fetch("http://localhost:1234/v1/models");
    if (!res.ok) return null;
    const data = await res.json();
    return data.data?.[0]?.id || null;
  } catch {
    return null;
  }
}

// ── Provider availability checks ────────────────────────────

const availability = {};
let lmStudioModel = null;

beforeAll(async () => {
  // Check Prism is running
  try {
    const res = await fetch(PRISM_SERVICE_URL);
    if (!res.ok) throw new Error("Prism not responding");
  } catch {
    throw new Error(
      `Prism is not running at ${PRISM_SERVICE_URL}. Start it with: npm run dev`,
    );
  }

  // Check each provider
  availability.openai = await isProviderAvailable(PROVIDERS.OPENAI, "gpt-5-nano");
  availability.anthropic = await isProviderAvailable(
    PROVIDERS.ANTHROPIC,
    "claude-haiku-4-5-20251001",
  );
  availability.google = await isProviderAvailable(
    PROVIDERS.GOOGLE,
    "gemini-3-flash-preview",
  );

  // Check LM Studio
  lmStudioModel = await isLmStudioAvailable();
  availability.lmStudio = !!lmStudioModel;

  console.log("\n  Provider availability:");
  console.log(`    OpenAI:     ${availability.openai ? "✓" : "✗"}`);
  console.log(`    Anthropic:  ${availability.anthropic ? "✓" : "✗"}`);
  console.log(`    Google:     ${availability.google ? "✓" : "✗"}`);
  console.log(
    `    LM Studio:  ${lmStudioModel ? `✓ (${lmStudioModel})` : "✗ (not running)"}\n`,
  );
}, 30_000);

// ═════════════════════════════════════════════════════════════
// OpenAI — GPT-5 Nano
// ═════════════════════════════════════════════════════════════

describe("Live — OpenAI gpt-5-nano", () => {
  const MODEL = "gpt-5-nano";
  const PROVIDER = PROVIDERS.OPENAI;

  it("returns valid tokens and cost WITHOUT function calling", async () => {
    if (!availability.openai) return;

    const res = await chat({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: SIMPLE_PROMPT }],
      maxTokens: 20,
    });

    expect(res.usage).toBeDefined();
    expect(res.usage.inputTokens).toBeGreaterThan(0);
    expect(res.usage.outputTokens).toBeGreaterThan(0);
    expect(res.estimatedCost).toBeGreaterThan(0);

    // Verify cost matches our calculator
    const pricing = TEXT_PRICING[MODEL];
    const expectedCost = calculateTextCost(res.usage, pricing);
    expect(res.estimatedCost).toBeCloseTo(expectedCost, 8);

    // Sanity: a one-word prompt should be < 100 input tokens
    expect(res.usage.inputTokens).toBeLessThan(100);
  });

  it("returns valid tokens and cost WITH 10 tools (function calling)", async () => {
    if (!availability.openai) return;

    const res = await chat({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: SIMPLE_PROMPT }],
      tools: SAMPLE_TOOLS,
      maxTokens: 20,
    });

    expect(res.usage).toBeDefined();
    expect(res.usage.inputTokens).toBeGreaterThan(0);
    expect(res.usage.outputTokens).toBeGreaterThan(0);
    expect(res.estimatedCost).toBeGreaterThan(0);

    // Tools should inflate input tokens significantly
    // 10 tool definitions typically add ~2000-5000 input tokens
    expect(res.usage.inputTokens).toBeGreaterThan(500);

    // Verify cost calculation
    const pricing = TEXT_PRICING[MODEL];
    const expectedCost = calculateTextCost(res.usage, pricing);
    expect(res.estimatedCost).toBeCloseTo(expectedCost, 8);
  });

  it("FC request costs more than non-FC due to tool definitions", async () => {
    if (!availability.openai) return;

    const [noTools, withTools] = await Promise.all([
      chat({
        provider: PROVIDER,
        model: MODEL,
        messages: [{ role: "user", content: SIMPLE_PROMPT }],
        maxTokens: 20,
      }),
      chat({
        provider: PROVIDER,
        model: MODEL,
        messages: [{ role: "user", content: SIMPLE_PROMPT }],
        tools: SAMPLE_TOOLS,
        maxTokens: 20,
      }),
    ]);

    expect(withTools.usage.inputTokens).toBeGreaterThan(
      noTools.usage.inputTokens,
    );
    expect(withTools.estimatedCost).toBeGreaterThan(noTools.estimatedCost);
  });
});

// ═════════════════════════════════════════════════════════════
// Anthropic — Haiku 4.5
// ═════════════════════════════════════════════════════════════

describe("Live — Anthropic haiku-4.5", () => {
  const MODEL = "claude-haiku-4-5-20251001";
  const PROVIDER = PROVIDERS.ANTHROPIC;

  it("returns valid tokens and cost WITHOUT function calling", async () => {
    if (!availability.anthropic) return;

    const res = await chat({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: SIMPLE_PROMPT }],
      maxTokens: 20,
    });

    expect(res.usage).toBeDefined();
    expect(res.usage.inputTokens).toBeGreaterThan(0);
    expect(res.usage.outputTokens).toBeGreaterThan(0);
    expect(res.estimatedCost).toBeGreaterThan(0);

    const pricing = TEXT_PRICING[MODEL];
    const expectedCost = calculateTextCost(res.usage, pricing);
    expect(res.estimatedCost).toBeCloseTo(expectedCost, 8);

    expect(res.usage.inputTokens).toBeLessThan(100);
  });

  it("returns cache token fields when present", async () => {
    if (!availability.anthropic) return;

    // Two sequential requests — second one should see cache reads
    await chat({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: SIMPLE_PROMPT }],
      tools: SAMPLE_TOOLS,
      maxTokens: 20,
    });

    const res = await chat({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: "Now say goodbye." }],
      tools: SAMPLE_TOOLS,
      maxTokens: 20,
    });

    expect(res.usage).toBeDefined();
    // Cache fields should exist on the usage object (may be 0 on first priming)
    expect(typeof res.usage.cacheReadInputTokens).toBe("number");
    expect(typeof res.usage.cacheCreationInputTokens).toBe("number");

    // Cost should account for all tiers
    const pricing = TEXT_PRICING[MODEL];
    const expectedCost = calculateTextCost(res.usage, pricing);
    expect(res.estimatedCost).toBeCloseTo(expectedCost, 8);
  });

  it("returns valid tokens and cost WITH 10 tools (function calling)", async () => {
    if (!availability.anthropic) return;

    const res = await chat({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: SIMPLE_PROMPT }],
      tools: SAMPLE_TOOLS,
      maxTokens: 20,
    });

    expect(res.usage).toBeDefined();
    expect(res.usage.inputTokens).toBeGreaterThan(0);
    expect(res.usage.outputTokens).toBeGreaterThan(0);
    expect(res.estimatedCost).toBeGreaterThan(0);

    // Tools inflate input tokens
    const totalInput =
      (res.usage.inputTokens || 0) +
      (res.usage.cacheReadInputTokens || 0) +
      (res.usage.cacheCreationInputTokens || 0);
    expect(totalInput).toBeGreaterThan(500);
  });
});

// ═════════════════════════════════════════════════════════════
// Google — Gemini 3 Flash
// ═════════════════════════════════════════════════════════════

describe("Live — Google gemini-3-flash", () => {
  const MODEL = "gemini-3-flash-preview";
  const PROVIDER = PROVIDERS.GOOGLE;

  it("returns valid tokens and cost WITHOUT function calling", async () => {
    if (!availability.google) return;

    const res = await chat({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: "What is 2 + 2?" }],
      maxTokens: 50,
    });

    expect(res.usage).toBeDefined();
    expect(res.usage.inputTokens).toBeGreaterThan(0);
    expect(res.usage.outputTokens).toBeGreaterThan(0);
    expect(res.text).toBeTruthy();
    expect(res.estimatedCost).toBeGreaterThan(0);

    const pricing = TEXT_PRICING[MODEL];
    const expectedCost = calculateTextCost(res.usage, pricing);
    expect(res.estimatedCost).toBeCloseTo(expectedCost, 8);

    expect(res.usage.inputTokens).toBeLessThan(100);
  });

  it("returns valid tokens and cost WITH 10 tools (function calling)", async () => {
    if (!availability.google) return;

    const res = await chat({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: "What is 2 + 2?" }],
      tools: SAMPLE_TOOLS,
      maxTokens: 50,
    });

    expect(res.usage).toBeDefined();
    expect(res.usage.inputTokens).toBeGreaterThan(0);
    // Output tokens may be 0 if Gemini spends budget on thinking
    expect(res.usage.outputTokens).toBeGreaterThanOrEqual(0);
    expect(res.estimatedCost).toBeGreaterThanOrEqual(0);

    // Tools should inflate input tokens
    expect(res.usage.inputTokens).toBeGreaterThan(100);

    const pricing = TEXT_PRICING[MODEL];
    const expectedCost = calculateTextCost(res.usage, pricing);
    expect(res.estimatedCost).toBeCloseTo(expectedCost, 8);
  });

  it("FC request costs more than non-FC due to tool definitions", async () => {
    if (!availability.google) return;

    const [noTools, withTools] = await Promise.all([
      chat({
        provider: PROVIDER,
        model: MODEL,
        messages: [{ role: "user", content: "What is 2 + 2?" }],
        maxTokens: 50,
      }),
      chat({
        provider: PROVIDER,
        model: MODEL,
        messages: [{ role: "user", content: "What is 2 + 2?" }],
        tools: SAMPLE_TOOLS,
        maxTokens: 50,
      }),
    ]);

    expect(withTools.usage.inputTokens).toBeGreaterThan(
      noTools.usage.inputTokens,
    );
  });
});

// ═════════════════════════════════════════════════════════════
// LM Studio — Local model (free, $0 pricing)
// ═════════════════════════════════════════════════════════════

describe("Live — LM Studio (local)", () => {
  it("returns valid tokens with zero cost", async () => {
    if (!lmStudioModel) return;

    const res = await chat({
      provider: PROVIDERS.LM_STUDIO,
      model: lmStudioModel,
      messages: [{ role: "user", content: SIMPLE_PROMPT }],
      maxTokens: 20,
    });

    expect(res.usage).toBeDefined();
    expect(res.usage.inputTokens).toBeGreaterThan(0);
    expect(res.usage.outputTokens).toBeGreaterThan(0);

    // LM Studio has no pricing in config — cost should be null or 0
    expect(res.estimatedCost === null || res.estimatedCost === 0).toBe(true);
  });

  it("returns valid tokens WITH tools", async () => {
    if (!lmStudioModel) return;

    const res = await chat({
      provider: "lm-studio",
      model: lmStudioModel,
      messages: [{ role: "user", content: SIMPLE_PROMPT }],
      tools: SAMPLE_TOOLS,
      maxTokens: 20,
    });

    expect(res.usage).toBeDefined();
    expect(res.usage.inputTokens).toBeGreaterThan(0);
    expect(res.usage.outputTokens).toBeGreaterThan(0);
  });
});

// ═════════════════════════════════════════════════════════════
// Cross-provider consistency
// ═════════════════════════════════════════════════════════════

describe("Live — Cross-provider consistency", () => {
  it("all available providers return matching cost calculation", async () => {
    const providers = [
      {
        provider: PROVIDERS.OPENAI,
        model: "gpt-5-nano",
        available: availability.openai,
      },
      {
        provider: PROVIDERS.ANTHROPIC,
        model: "claude-haiku-4-5-20251001",
        available: availability.anthropic,
      },
      {
        provider: PROVIDERS.GOOGLE,
        model: "gemini-3-flash-preview",
        available: availability.google,
      },
    ];

    for (const { provider, model, available } of providers) {
      if (!available) continue;

      const res = await chat({
        provider,
        model,
        messages: [{ role: "user", content: SIMPLE_PROMPT }],
        maxTokens: 20,
      });

      // Verify cost matches our calculator for every provider
      const pricing = TEXT_PRICING[model];
      const expectedCost = calculateTextCost(res.usage, pricing);
      expect(res.estimatedCost).toBeCloseTo(expectedCost, 8);

      // Response shape is consistent
      expect(res).toHaveProperty("text");
      expect(res).toHaveProperty("provider", provider);
      expect(res).toHaveProperty("model");
      expect(res).toHaveProperty("usage");
      expect(res).toHaveProperty("estimatedCost");
    }
  });
});
