import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import {
  app,
  MOCK_GENERATE_TEXT,
  MOCK_GENERATE_TEXT_STREAM,
} from "./setup.ts";
import { calculateTextCost } from "../src/utils/CostCalculator.ts";
import { TYPES, getPricing, MODELS } from "../src/config.ts";
import { PROVIDERS } from "../src/constants.ts";


// ═══════════════════════════════════════════════════════════════
// Token & Cost Accuracy Tests
// ═══════════════════════════════════════════════════════════════
// Verifies the full pipeline: mock provider returns usage →
// chat route applies real pricing → response has correct cost.
//
// Uses the cheapest model per provider that supports Function Calling:
//   • OpenAI:    gpt-5-nano      ($0.025/$0.20 per M)
//   • Anthropic: claude-haiku-4-5-20251001 ($1.00/$5.00 per M + cache tiers)
//   • Google:    gemini-3-flash-preview    ($0.50/$3.00 per M)
// ═══════════════════════════════════════════════════════════════

const TEXT_PRICING = getPricing(TYPES.TEXT, TYPES.TEXT);

// ── 10 real tool definitions from tools.rod.dev ────────
// Sourced from GET /admin/tool-schemas — covers Weather,
// Events, Markets, Finance, Knowledge, Health, Transit, Utilities.
const SAMPLE_TOOLS = [
  // 1. Weather & Environment — get_current_weather
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
  // 2. Weather & Environment — get_earthquakes
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
  // 3. Events — search_events
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
  // 4. Markets & Commodities — get_commodity_ticker
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
  // 5. Finance — get_stock_quote
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
  // 6. Knowledge — get_wikipedia_summary
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
  // 7. Health — search_usda_nutrition
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
  // 8. Transit — get_next_bus
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
  // 9. Utilities — convert_currency
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
  // 10. Knowledge — search_papers
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

// ── Helper: compute expected cost from config pricing ────────
function expectedCost(model: string, usage: any): number {
  const pricing = TEXT_PRICING[model];
  expect(pricing).toBeDefined();
  return calculateTextCost(usage, pricing)!;
}

// ── Helper: send chat request (non-streaming) ────────────────
function sendChat(payload: any) {
  return request(app)
    .post("/chat?stream=false")
    .send(payload);
}

// ═══════════════════════════════════════════════════════════════
// 1. OpenAI — GPT-5 Nano (cheapest FC model)
// ═══════════════════════════════════════════════════════════════

describe(`Token/Cost Accuracy — OpenAI ${MODELS.GPT_5_NANO.name}`, () => {
  const MODEL = MODELS.GPT_5_NANO.name;
  const PROVIDER = PROVIDERS.OPENAI;

  beforeEach(() => {
    MOCK_GENERATE_TEXT.mockClear();
    MOCK_GENERATE_TEXT_STREAM.mockClear();
  });

  it("calculates correct cost WITHOUT function calling", async () => {
    const usage = { inputTokens: 500, outputTokens: 200 };
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "Hello from nano";
      yield { type: "usage", usage };
    });

    const res = await sendChat({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: "Hello" }],
    }).expect(200);

    const expected = expectedCost(MODEL, usage);
    expect(res.body.usage.inputTokens).toBe(500);
    expect(res.body.usage.outputTokens).toBe(200);
    expect(res.body.estimatedCost).toBeCloseTo(expected, 8);

    // Manual verification: (500/1M)*0.05 + (200/1M)*0.40
    // = 0.000025 + 0.00008 = 0.000105
    expect(expected).toBeCloseTo(0.000105, 8);
  });

  it("calculates correct cost WITH 10 tools (function calling)", async () => {
    // Tools add input tokens (system prompt overhead)
    const usage = { inputTokens: 3500, outputTokens: 100 };
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "Tool result processed";
      yield { type: "usage", usage };
    });

    const res = await sendChat({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: "What's the weather?" }],
      tools: SAMPLE_TOOLS,
    }).expect(200);

    const expected = expectedCost(MODEL, usage);
    expect(res.body.usage.inputTokens).toBe(3500);
    expect(res.body.usage.outputTokens).toBe(100);
    expect(res.body.estimatedCost).toBeCloseTo(expected, 8);

    // Manual: (3500/1M)*0.05 + (100/1M)*0.40
    // = 0.000175 + 0.00004 = 0.000215
    expect(expected).toBeCloseTo(0.000215, 8);
  });

  it("calculates correct cost with cached input tokens", async () => {
    const usage = { inputTokens: 100, outputTokens: 50 };
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "Cached response";
      yield { type: "usage", usage };
    });

    const res = await sendChat({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: "Hi" }],
    }).expect(200);

    const expected = expectedCost(MODEL, usage);
    expect(res.body.estimatedCost).toBeCloseTo(expected, 8);

    // Manual: (100/1M)*0.05 + (50/1M)*0.40 = 0.000005 + 0.00002 = 0.000025
    expect(expected).toBeCloseTo(0.000025, 8);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. Anthropic — Haiku 4.5 (cheapest FC model)
// ═══════════════════════════════════════════════════════════════

describe(`Token/Cost Accuracy — Anthropic ${MODELS.HAIKU_45.name}`, () => {
  const MODEL = MODELS.HAIKU_45.name;
  const PROVIDER = PROVIDERS.ANTHROPIC;

  beforeEach(() => {
    MOCK_GENERATE_TEXT.mockClear();
    MOCK_GENERATE_TEXT_STREAM.mockClear();
  });

  it("calculates correct cost WITHOUT function calling — no cache", async () => {
    const usage = { inputTokens: 500, outputTokens: 200 };
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "Hello from haiku";
      yield { type: "usage", usage };
    });

    const res = await sendChat({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: "Hello" }],
    }).expect(200);

    const expected = expectedCost(MODEL, usage);
    expect(res.body.usage.inputTokens).toBe(500);
    expect(res.body.usage.outputTokens).toBe(200);
    expect(res.body.estimatedCost).toBeCloseTo(expected, 8);

    // Manual: (500/1M)*1.0 + (200/1M)*5.0 = 0.0005 + 0.001 = 0.0015
    expect(expected).toBeCloseTo(0.0015, 8);
  });

  it("calculates correct cost WITHOUT FC — with cache read", async () => {
    const usage = {
      inputTokens: 50,
      outputTokens: 200,
      cacheReadInputTokens: 5000,
      cacheCreationInputTokens: 0,
    };
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "Cached haiku response";
      yield { type: "usage", usage };
    });

    const res = await sendChat({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: "Hello again" }],
    }).expect(200);

    const expected = expectedCost(MODEL, usage);
    expect(res.body.estimatedCost).toBeCloseTo(expected, 8);

    // Manual: new=(50/1M)*1.0 + cache_read=(5000/1M)*0.1 + out=(200/1M)*5.0
    // = 0.00005 + 0.0005 + 0.001 = 0.00155
    expect(expected).toBeCloseTo(0.00155, 8);
  });

  it("calculates correct cost WITHOUT FC — with cache write", async () => {
    const usage = {
      inputTokens: 500,
      outputTokens: 200,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 2000,
    };
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "Cache write response";
      yield { type: "usage", usage };
    });

    const res = await sendChat({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: "New conversation" }],
    }).expect(200);

    const expected = expectedCost(MODEL, usage);
    expect(res.body.estimatedCost).toBeCloseTo(expected, 8);

    // Manual: new=(500/1M)*1.0 + cache_write=(2000/1M)*1.25 + out=(200/1M)*5.0
    // = 0.0005 + 0.0025 + 0.001 = 0.004
    expect(expected).toBeCloseTo(0.004, 8);
  });

  it("calculates correct cost WITH FC — cache read + write", async () => {
    // Realistic FC scenario: tools in cache (read), new tool result (write)
    const usage = {
      inputTokens: 100,
      outputTokens: 150,
      cacheReadInputTokens: 24000,
      cacheCreationInputTokens: 800,
    };
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "FC result from haiku";
      yield { type: "usage", usage };
    });

    const res = await sendChat({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: "What's the weather?" }],
      tools: SAMPLE_TOOLS,
    }).expect(200);

    const expected = expectedCost(MODEL, usage);
    expect(res.body.usage.inputTokens).toBe(100);
    expect(res.body.usage.outputTokens).toBe(150);
    expect(res.body.usage.cacheReadInputTokens).toBe(24000);
    expect(res.body.usage.cacheCreationInputTokens).toBe(800);
    expect(res.body.estimatedCost).toBeCloseTo(expected, 8);

    // Manual:
    //   new    = (100/1M)*1.0    = 0.0001
    //   read   = (24000/1M)*0.1  = 0.0024
    //   write  = (800/1M)*1.25   = 0.001
    //   output = (150/1M)*5.0    = 0.00075
    //   total  =                   0.00425
    expect(expected).toBeCloseTo(0.00425, 8);
  });

  it("calculates correct cost WITH FC — heavy cache read (tool definitions)", async () => {
    // Second request in conversation: all tool defs cached
    const usage = {
      inputTokens: 8,
      outputTokens: 400,
      cacheReadInputTokens: 25000,
      cacheCreationInputTokens: 0,
    };
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "Second FC round response";
      yield { type: "usage", usage };
    });

    const res = await sendChat({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: "Now search for recipes" }],
      tools: SAMPLE_TOOLS,
    }).expect(200);

    const expected = expectedCost(MODEL, usage);
    expect(res.body.estimatedCost).toBeCloseTo(expected, 8);

    // Manual:
    //   new    = (8/1M)*1.0        = 0.000008
    //   read   = (25000/1M)*0.1    = 0.0025
    //   output = (400/1M)*5.0      = 0.002
    //   total  =                     0.004508
    expect(expected).toBeCloseTo(0.004508, 8);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Google — Gemini 3 Flash (cheapest FC model)
// ═══════════════════════════════════════════════════════════════

describe(`Token/Cost Accuracy — Google ${MODELS.GEMINI_3_FLASH.name}`, () => {
  const MODEL = MODELS.GEMINI_3_FLASH.name;
  const PROVIDER = PROVIDERS.GOOGLE;

  beforeEach(() => {
    MOCK_GENERATE_TEXT.mockClear();
    MOCK_GENERATE_TEXT_STREAM.mockClear();
  });

  it("calculates correct cost WITHOUT function calling", async () => {
    const usage = { inputTokens: 500, outputTokens: 200 };
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "Hello from gemini";
      yield { type: "usage", usage };
    });

    const res = await sendChat({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: "Hello" }],
    }).expect(200);

    const expected = expectedCost(MODEL, usage);
    expect(res.body.usage.inputTokens).toBe(500);
    expect(res.body.usage.outputTokens).toBe(200);
    expect(res.body.estimatedCost).toBeCloseTo(expected, 8);

    // Manual: (500/1M)*0.5 + (200/1M)*3.0 = 0.00025 + 0.0006 = 0.00085
    expect(expected).toBeCloseTo(0.00085, 8);
  });

  it("calculates correct cost WITH 10 tools (function calling)", async () => {
    const usage = { inputTokens: 4000, outputTokens: 120 };
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "Gemini FC result";
      yield { type: "usage", usage };
    });

    const res = await sendChat({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: "Search for data" }],
      tools: SAMPLE_TOOLS,
    }).expect(200);

    const expected = expectedCost(MODEL, usage);
    expect(res.body.usage.inputTokens).toBe(4000);
    expect(res.body.usage.outputTokens).toBe(120);
    expect(res.body.estimatedCost).toBeCloseTo(expected, 8);

    // Manual: (4000/1M)*0.5 + (120/1M)*3.0 = 0.002 + 0.00036 = 0.00236
    expect(expected).toBeCloseTo(0.00236, 8);
  });

  it("handles large context window (100k+ tokens)", async () => {
    const usage = { inputTokens: 100_000, outputTokens: 8000 };
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "Large context response";
      yield { type: "usage", usage };
    });

    const res = await sendChat({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: "Summarize all of this" }],
    }).expect(200);

    const expected = expectedCost(MODEL, usage);
    expect(res.body.estimatedCost).toBeCloseTo(expected, 6);

    // Manual: (100000/1M)*0.5 + (8000/1M)*3.0 = 0.05 + 0.024 = 0.074
    expect(expected).toBeCloseTo(0.074, 6);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Cross-provider consistency checks
// ═══════════════════════════════════════════════════════════════

describe("Cross-provider cost consistency", () => {
  beforeEach(() => {
    MOCK_GENERATE_TEXT.mockClear();
    MOCK_GENERATE_TEXT_STREAM.mockClear();
  });

  it("all providers return estimatedCost as a number (not null) for known models", async () => {
    const cases = [
      { provider: PROVIDERS.OPENAI, model: MODELS.GPT_5_NANO.name },
      { provider: PROVIDERS.ANTHROPIC, model: MODELS.HAIKU_45.name },
      { provider: PROVIDERS.GOOGLE, model: MODELS.GEMINI_3_FLASH.name },
    ];

    for (const { provider, model } of cases) {
      MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
        yield "Test";
        yield {
          type: "usage",
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      });

      const res = await sendChat({
        provider,
        model,
        messages: [{ role: "user", content: "Test cost" }],
      }).expect(200);

      expect(typeof res.body.estimatedCost).toBe("number");
      expect(res.body.estimatedCost).toBeGreaterThan(0);
    }
  });

  it("cost increases proportionally with token count", async () => {
    const results = [];

    for (const tokenCount of [100, 1000, 10000]) {
      MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
        yield "Test";
        yield {
          type: "usage",
          usage: { inputTokens: tokenCount, outputTokens: tokenCount / 2 },
        };
      });

      const res = await sendChat({
        provider: PROVIDERS.OPENAI,
        model: MODELS.GPT_5_NANO.name,
        messages: [{ role: "user", content: "Scale test" }],
      }).expect(200);

      results.push(res.body.estimatedCost);
    }

    // Each 10x token increase should yield ~10x cost increase
    expect(results[1] / results[0]).toBeCloseTo(10, 0);
    expect(results[2] / results[1]).toBeCloseTo(10, 0);
  });

  it("tools in request do not inflate cost when usage tokens are the same", async () => {
    const usage = { inputTokens: 500, outputTokens: 200 };

    // Without tools
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "No tools";
      yield { type: "usage", usage };
    });
    const resNoTools = await sendChat({
      provider: PROVIDERS.GOOGLE,
      model: MODELS.GEMINI_3_FLASH.name,
      messages: [{ role: "user", content: "Hello" }],
    }).expect(200);

    // With tools (same usage from provider)
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "With tools";
      yield { type: "usage", usage };
    });
    const resWithTools = await sendChat({
      provider: PROVIDERS.GOOGLE,
      model: MODELS.GEMINI_3_FLASH.name,
      messages: [{ role: "user", content: "Hello" }],
      tools: SAMPLE_TOOLS,
    }).expect(200);

    // Cost should be identical — we price based on usage, not payload
    expect(resWithTools.body.estimatedCost).toBe(resNoTools.body.estimatedCost);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Edge cases
// ═══════════════════════════════════════════════════════════════

describe("Token/Cost edge cases", () => {
  beforeEach(() => {
    MOCK_GENERATE_TEXT_STREAM.mockClear();
  });

  it("zero output tokens still computes input cost", async () => {
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "";
      yield {
        type: "usage",
        usage: { inputTokens: 1000, outputTokens: 0 },
      };
    });

    const res = await sendChat({
      provider: PROVIDERS.ANTHROPIC,
      model: MODELS.HAIKU_45.name,
      messages: [{ role: "user", content: "Empty response test" }],
    }).expect(200);

    // Manual: (1000/1M)*1.0 + 0 = 0.001
    expect(res.body.estimatedCost).toBeCloseTo(0.001, 8);
  });

  it("very large token counts compute correctly", async () => {
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "Big response";
      yield {
        type: "usage",
        usage: { inputTokens: 1_000_000, outputTokens: 100_000 },
      };
    });

    const res = await sendChat({
      provider: PROVIDERS.OPENAI,
      model: MODELS.GPT_5_NANO.name,
      messages: [{ role: "user", content: "Max context" }],
    }).expect(200);

    // Manual: (1M/1M)*0.05 + (100k/1M)*0.40 = 0.05 + 0.04 = 0.09
    expect(res.body.estimatedCost).toBeCloseTo(0.09, 6);
  });

  it("Anthropic cache fields propagate through to usage in response", async () => {
    const usage = {
      inputTokens: 10,
      outputTokens: 50,
      cacheReadInputTokens: 10000,
      cacheCreationInputTokens: 500,
    };
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "Cache propagation test";
      yield { type: "usage", usage };
    });

    const res = await sendChat({
      provider: PROVIDERS.ANTHROPIC,
      model: MODELS.HAIKU_45.name,
      messages: [{ role: "user", content: "Cache test" }],
    }).expect(200);

    // Verify cache fields are present in the response usage object
    expect(res.body.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 50,
      cacheReadInputTokens: 10000,
      cacheCreationInputTokens: 500,
    });

    // Verify cost includes all cache tiers
    const expected = expectedCost(MODELS.HAIKU_45.name, usage);
    expect(res.body.estimatedCost).toBeCloseTo(expected, 8);

    // Manual:
    //   new    = (10/1M)*1.0      = 0.00001
    //   read   = (10000/1M)*0.1   = 0.001
    //   write  = (500/1M)*1.25    = 0.000625
    //   output = (50/1M)*5.0      = 0.00025
    //   total  =                    0.001885
    expect(expected).toBeCloseTo(0.001885, 8);
  });
});
