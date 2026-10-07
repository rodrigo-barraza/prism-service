/**
 * /chat's function calling runs the model's tool calls with no approval
 * engine (ChatRoutes). A service's turn there runs under the default scope
 * of a service's turn (ServiceTurnLimits), whatever the agent — no persona
 * policy judges this path: nothing that uses the shell, file writes,
 * outside actions or MCP is offered, and a call to one is refused before it
 * runs. A signed-in user's turn is untouched.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { PROVIDERS } from "#src/constants";
import { app, MOCK_GENERATE_TEXT_STREAM } from "./setup.ts";
import { serviceHeaders, userHeaders } from "./helpers/auth.ts";
import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import { registerToolCapabilities } from "#src/services/permissions/ToolCapabilities";
import { deniedCapabilityOf, serviceTurnScope } from "#src/utils/ServiceTurnLimits";

// tools-service's tags (ToolCapabilities.ts); the harness's catalog sends none.
registerToolCapabilities(
  [
    { name: "get_weather", capabilities: ["network"] },
    { name: "send_email", capabilities: ["network", "external_side_effect"] },
  ],
  "test",
);

const executeTool = vi
  .spyOn(ToolOrchestratorService, "executeTool")
  .mockResolvedValue({ success: true, result: "sunny" } as never);
afterAll(() => executeTool.mockRestore());

const DEFAULT_SCOPE = serviceTurnScope(null);
const CALLS = ["execute_python", "send_email", "get_weather"];

/** One step calling every tool in CALLS, then a closing answer. */
function scriptCalls() {
  MOCK_GENERATE_TEXT_STREAM.mockReset();
  MOCK_GENERATE_TEXT_STREAM.mockImplementationOnce(async function* () {
    for (const name of CALLS) {
      yield { type: "toolCall", id: `call-${name}`, name, args: name === "get_weather" ? { city: "Vancouver" } : {} };
    }
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
  });
  MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
    yield "Done.";
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
  });
}

const offered = (): string[] =>
  ((MOCK_GENERATE_TEXT_STREAM.mock.calls[0][2] as { tools?: Array<{ name: string }> }).tools ?? []).map(
    (tool) => tool.name,
  );
const executed = (): string[] => executeTool.mock.calls.map((call) => call[0] as string);
const BODY = {
  provider: PROVIDERS.OPENAI,
  messages: [{ role: "user", content: "Weather in Vancouver, then email it to me." }],
  functionCallingEnabled: true,
};

describe("/chat function calling for a service's turn", () => {
  beforeEach(() => {
    executeTool.mockClear();
    scriptCalls();
  });

  it("offers nothing the scope denies and refuses a denied call before it runs — LUPOS named or not", async () => {
    await request(app)
      .post("/chat?stream=false")
      .set(serviceHeaders("visitor"))
      .send({ ...BODY, agent: "LUPOS" })
      .expect(200);

    expect(offered()).toContain("get_weather");
    expect(offered().filter((name) => deniedCapabilityOf(name, DEFAULT_SCOPE) !== null)).toEqual([]);
    expect(executed()).toEqual(["get_weather"]);
    const followUp = JSON.stringify(MOCK_GENERATE_TEXT_STREAM.mock.calls[1][0]);
    expect(followUp.match(/CAPABILITY_SCOPE_DENIED/g)).toHaveLength(2);
    expect(followUp).toContain("[Capability scope]");
  });

  it("a signed-in user's turn is offered and runs them as before", async () => {
    await request(app).post("/chat?stream=false").set(userHeaders("rodrigo")).send(BODY).expect(200);

    expect(offered().some((name) => deniedCapabilityOf(name, DEFAULT_SCOPE) !== null)).toBe(true);
    expect(executed()).toEqual(CALLS);
    expect(JSON.stringify(MOCK_GENERATE_TEXT_STREAM.mock.calls[1][0])).not.toContain("CAPABILITY_SCOPE_DENIED");
  });
});
