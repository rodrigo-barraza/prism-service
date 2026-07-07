import { describe, it, expect, beforeAll } from "vitest";
import { PROVIDERS } from "#src/constants";

const PRISM_SERVICE_URL = process.env.PRISM_SERVICE_URL || "http://localhost:7777";

describe("Live Function Calling Orchestration", () => {
  beforeAll(async () => {
    try {
      const res = await fetch(`${PRISM_SERVICE_URL}`);
      if (!res.ok) throw new Error("Health check failed");
    } catch {
      throw new Error(`Prism not running at ${PRISM_SERVICE_URL}`);
    }
  });

  it("should execute a tool call end-to-end via AgenticLoopService using Anthropic", async () => {
    const payload = {
      provider: PROVIDERS.ANTHROPIC,
      model: "claude-haiku-4-5-20251001",
      functionCallingEnabled: true,
      enabledTools: ["get_current_weather"],
      messages: [{ role: "user", content: "What is the current weather in Tokyo?" }],
      project: "live-tests",
      username: "vitest",
    };

    const res = await fetch(`${PRISM_SERVICE_URL}/chat?stream=false`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = (await res.json()) as any;
    
    expect(res.status).toBe(200);
    expect(data.text).toBeTypeOf("string");
    
    expect(data.toolCalls).toBeDefined();
    expect(Array.isArray(data.toolCalls)).toBe(true);
    expect(data.toolCalls.length).toBeGreaterThan(0);
    
    const weatherCall = data.toolCalls.find((toolCall: any) => toolCall.name === "get_current_weather");
    expect(weatherCall).toBeDefined();
    
    expect(data.usage).toBeDefined();
    expect(data.usage.inputTokens).toBeGreaterThan(0);
  }, 40000); // 40s timeout for agentic loop
});
