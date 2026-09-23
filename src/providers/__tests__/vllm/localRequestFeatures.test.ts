/**
 * Request features of the self-hosted runtimes (local-request-features.ts),
 * through the vLLM and llama.cpp providers against a stubbed server:
 *
 *   - strict tool arguments only on a model whose profile says vLLM can
 *     constrain them
 *   - a JSON-schema response as `structured_outputs` on vLLM ≥ 0.12 and
 *     `guided_json` before it; `response_format` on llama-server, which is
 *     never sent a `grammar`
 *   - X-Vllm-Priority on background calls (the memory role) and only on an
 *     instance started with priority scheduling
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createVllmProvider } from "#src/providers/vllm";
import { createLlamaCppProvider } from "#src/providers/llama-cpp";
import { BACKGROUND_PRIORITY, _clearVllmVersions } from "#src/providers/local-request-features";
import { runWithRequestPriority, currentRequestPriority } from "#src/services/RequestPriority";
import ModelRoleRouter, { MODEL_ROLES } from "#src/services/ModelRoleRouter";
import type { ProviderOptions } from "#src/types/ProviderTypes";
import type { ChatMessage } from "#src/types/provider";

const BASE_URL = "http://vllm-box:8000";

interface SentRequest {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

let sent: SentRequest[] = [];
let serverVersion: string | null = "0.13.1";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  sent = [];
  serverVersion = "0.13.1";
  _clearVllmVersions();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const path = url.slice(BASE_URL.length);
      if (path === "/version") return serverVersion ? json({ version: serverVersion }) : new Response("", { status: 404 });
      if (path === "/v1/models") return json({ object: "list", data: [{ id: "model", max_model_len: 32768 }] });
      if (path === "/props") return json({ default_generation_settings: { n_ctx: 32768 } });
      if (path === "/v1/chat/completions") {
        sent.push({
          url,
          body: JSON.parse(String(init?.body)),
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
        });
        return json({
          id: "chatcmpl-1",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "{}" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        });
      }
      return new Response("Not Found", { status: 404 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

const hello: ChatMessage[] = [{ role: "user", content: "hello" }];
const tools: ProviderOptions["tools"] = [
  {
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];
const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };

const lastChat = () => sent.at(-1)!;

describe("vLLM — strict tool arguments", () => {
  it("marks each function tool strict for a model with structural-tag support", async () => {
    await createVllmProvider(BASE_URL, "vllm").generateText(hello, "Qwen/Qwen3.8-27B", { tools });
    const sentTools = lastChat().body.tools as Array<{ function: { strict?: boolean } }>;
    expect(sentTools.map((tool) => tool.function.strict)).toEqual([true]);
  });

  it("leaves tools alone for a model without it", async () => {
    await createVllmProvider(BASE_URL, "vllm").generateText(hello, "google/gemma-4-12b-it", { tools });
    const sentTools = lastChat().body.tools as Array<{ function: Record<string, unknown> }>;
    expect(sentTools[0].function).not.toHaveProperty("strict");
  });
});

describe("vLLM — guided decoding for a JSON-schema response", () => {
  it("sends structured_outputs to vLLM 0.12 and later", async () => {
    await createVllmProvider(BASE_URL, "vllm").generateText(hello, "Qwen/Qwen3.8-27B", {
      responseFormat: "json_schema",
      responseSchema: { name: "answer", schema },
    });
    expect(lastChat().body.structured_outputs).toEqual({ json: schema });
    expect(lastChat().body).not.toHaveProperty("guided_json");
  });

  it("sends guided_json to an older server", async () => {
    serverVersion = "0.11.2";
    await createVllmProvider(BASE_URL, "vllm").generateText(hello, "Qwen/Qwen3.8-27B", {
      responseFormat: "json_schema",
      responseSchema: schema,
    });
    expect(lastChat().body.guided_json).toEqual(schema);
    expect(lastChat().body).not.toHaveProperty("structured_outputs");
  });

  it("assumes a current server when /version does not answer", async () => {
    serverVersion = null;
    await createVllmProvider(BASE_URL, "vllm").generateText(hello, "Qwen/Qwen3.8-27B", {
      responseFormat: "json_object",
      responseSchema: schema,
    });
    expect(lastChat().body.structured_outputs).toEqual({ json: schema });
  });

  it("sends neither without a schema", async () => {
    await createVllmProvider(BASE_URL, "vllm").generateText(hello, "Qwen/Qwen3.8-27B", {});
    expect(lastChat().body).not.toHaveProperty("structured_outputs");
    expect(lastChat().body).not.toHaveProperty("guided_json");
  });
});

describe("vLLM — request priority by call type", () => {
  const prioritized = () =>
    createVllmProvider(BASE_URL, "vllm", { url: BASE_URL, priorityScheduling: true });

  it("an interactive call carries no priority", async () => {
    await prioritized().generateText(hello, "Qwen/Qwen3.8-27B", {});
    expect(lastChat().headers).not.toHaveProperty("x-vllm-priority");
  });

  it("a background call is served after interactive ones", async () => {
    await runWithRequestPriority("background", () =>
      prioritized().generateText(hello, "Qwen/Qwen3.8-27B", {}),
    );
    expect(lastChat().headers["x-vllm-priority"]).toBe(String(BACKGROUND_PRIORITY));
  });

  it("a background call streams with the header too", async () => {
    await runWithRequestPriority("background", async () => {
      const stream = prioritized().generateTextStream!(hello, "Qwen/Qwen3.8-27B", {});
      for await (const _chunk of stream) {
        // consume
      }
    }).catch(() => {});
    expect(lastChat().headers["x-vllm-priority"]).toBe(String(BACKGROUND_PRIORITY));
  });

  it("never sends a priority to a server without priority scheduling", async () => {
    await runWithRequestPriority("background", () =>
      createVllmProvider(BASE_URL, "vllm").generateText(hello, "Qwen/Qwen3.8-27B", {}),
    );
    expect(lastChat().headers).not.toHaveProperty("x-vllm-priority");
  });

  it("memory extraction runs at background priority, compaction and the critic interactively", async () => {
    const seen: Record<string, string> = {};
    const chain = [{ provider: "vllm", model: "Qwen/Qwen3.8-27B" }];
    for (const role of [MODEL_ROLES.MEMORY, MODEL_ROLES.UTILITY, MODEL_ROLES.CRITIC]) {
      await ModelRoleRouter.runWithChain(chain, async () => (seen[role] = currentRequestPriority()), {
        role,
        operation: "test",
      });
    }
    expect(seen).toEqual({ memory: "background", utility: "interactive", critic: "interactive" });
    expect(currentRequestPriority()).toBe("interactive");
  });
});

describe("llama.cpp — constrained output", () => {
  it("asks for a JSON-schema response with response_format and never sends a grammar", async () => {
    await createLlamaCppProvider(BASE_URL, "llama-cpp").generateText(hello, "qwen3.8-4b.gguf", {
      tools,
      responseFormat: "json_schema",
      responseSchema: { name: "answer", schema },
    });
    const { body } = lastChat();
    expect(body.response_format).toEqual({ type: "json_schema", json_schema: { schema } });
    expect(body).not.toHaveProperty("grammar");
    expect(body).not.toHaveProperty("json_schema");
    // Tool calls are constrained by the server's own grammar: the tools go as they are.
    expect((body.tools as Array<{ function: Record<string, unknown> }>)[0].function).not.toHaveProperty("strict");
  });

  it("sends no response_format without a schema", async () => {
    await createLlamaCppProvider(BASE_URL, "llama-cpp").generateText(hello, "qwen3.8-4b.gguf", {});
    expect(lastChat().body).not.toHaveProperty("response_format");
  });
});
