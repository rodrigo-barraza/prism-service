/**
 * Wire encoders for the fault-injection suite: one assistant reply — a line
 * of text, then one tool call whose arguments stream in pieces — written in
 * each provider's own streaming format, so ProviderFaultServer can send it
 * whole, cut, or with a piece missing.
 *
 * Formats follow each API's documented stream: OpenAI Responses SSE
 * (`event:` + `data:`), Anthropic Messages SSE, Gemini
 * `streamGenerateContent?alt=sse`, OpenAI-compatible Chat Completions SSE
 * (vLLM / llama.cpp / SGLang) and Ollama's `/api/chat` NDJSON.
 */

export interface ReplyPlan {
  text: string;
  tool: {
    callId: string;
    name: string;
    /** The arguments as streamed; joined they are the whole JSON (or not, for a malformed call). */
    argumentChunks: string[];
  };
  /** null: the provider reports no usage at all. */
  usage: { inputTokens: number; outputTokens: number } | null;
}

export interface WireReply {
  /** Every frame of the complete reply, terminal event included. */
  frames: string[];
  /** The frames of the same reply cut inside the tool call's arguments. */
  truncatedMidToolCall: string[];
}

export interface ProviderWire {
  contentType: string;
  reply(plan: ReplyPlan): WireReply;
}

function namedEvent(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function dataEvent(data: unknown): string {
  return `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

/** The first half of a frame — a connection cut in the middle of an event. */
function halfOf(frame: string): string {
  return frame.slice(0, Math.floor(frame.length / 2));
}

export const OPENAI_RESPONSES_WIRE: ProviderWire = {
  contentType: "text/event-stream",
  reply(plan) {
    const argumentsText = plan.tool.argumentChunks.join("");
    const functionItem = {
      type: "function_call",
      id: "fc_fault",
      call_id: plan.tool.callId,
      name: plan.tool.name,
    };
    const frames = [
      namedEvent("response.created", {
        response: { id: "resp_fault", object: "response", status: "in_progress", output: [] },
      }),
      namedEvent("response.output_item.added", {
        output_index: 0,
        item: { type: "message", id: "msg_fault", role: "assistant", status: "in_progress", content: [] },
      }),
      namedEvent("response.output_text.delta", {
        item_id: "msg_fault",
        output_index: 0,
        content_index: 0,
        delta: plan.text,
      }),
      namedEvent("response.output_item.added", {
        output_index: 1,
        item: { ...functionItem, arguments: "", status: "in_progress" },
      }),
    ];
    const firstArgumentFrame = frames.length;
    for (const piece of plan.tool.argumentChunks) {
      frames.push(
        namedEvent("response.function_call_arguments.delta", {
          item_id: "fc_fault",
          output_index: 1,
          delta: piece,
        }),
      );
    }
    frames.push(
      namedEvent("response.function_call_arguments.done", {
        item_id: "fc_fault",
        output_index: 1,
        arguments: argumentsText,
      }),
      namedEvent("response.output_item.done", {
        output_index: 1,
        item: { ...functionItem, arguments: argumentsText, status: "completed" },
      }),
      namedEvent("response.completed", {
        response: {
          id: "resp_fault",
          object: "response",
          status: "completed",
          output: [
            {
              type: "message",
              id: "msg_fault",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: plan.text, annotations: [] }],
            },
            { ...functionItem, arguments: argumentsText, status: "completed" },
          ],
          ...(plan.usage && {
            usage: {
              input_tokens: plan.usage.inputTokens,
              output_tokens: plan.usage.outputTokens,
              total_tokens: plan.usage.inputTokens + plan.usage.outputTokens,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          }),
        },
      }),
    );
    return { frames, truncatedMidToolCall: frames.slice(0, firstArgumentFrame + 1) };
  },
};

export const ANTHROPIC_WIRE: ProviderWire = {
  contentType: "text/event-stream",
  reply(plan) {
    // The Messages protocol always carries a usage object; a server that
    // does not count tokens leaves its fields out.
    const startUsage = plan.usage
      ? { input_tokens: plan.usage.inputTokens, output_tokens: 1 }
      : {};
    const frames = [
      namedEvent("message_start", {
        message: {
          id: "msg_fault",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: startUsage,
        },
      }),
      namedEvent("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      namedEvent("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: plan.text },
      }),
      namedEvent("content_block_stop", { index: 0 }),
      namedEvent("content_block_start", {
        index: 1,
        content_block: { type: "tool_use", id: plan.tool.callId, name: plan.tool.name, input: {} },
      }),
    ];
    const firstArgumentFrame = frames.length;
    for (const piece of plan.tool.argumentChunks) {
      frames.push(
        namedEvent("content_block_delta", {
          index: 1,
          delta: { type: "input_json_delta", partial_json: piece },
        }),
      );
    }
    frames.push(
      namedEvent("content_block_stop", { index: 1 }),
      namedEvent("message_delta", {
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: plan.usage ? { output_tokens: plan.usage.outputTokens } : {},
      }),
      namedEvent("message_stop", {}),
    );
    return { frames, truncatedMidToolCall: frames.slice(0, firstArgumentFrame + 1) };
  },
};

/**
 * Gemini sends each function call whole inside one event (arguments are a
 * JSON object, never streamed in pieces), so "mid-tool-call" is a cut inside
 * that event, and malformed arguments are an event whose JSON is broken.
 */
export const GEMINI_WIRE: ProviderWire = {
  contentType: "text/event-stream",
  reply(plan) {
    const argumentsText = plan.tool.argumentChunks.join("");
    let parsedArguments: unknown = null;
    try {
      parsedArguments = JSON.parse(argumentsText);
    } catch {
      /* malformed — written as broken JSON below */
    }
    const textEvent = dataEvent({
      candidates: [{ content: { role: "model", parts: [{ text: plan.text }] }, index: 0 }],
      responseId: "resp_fault",
      modelVersion: "gemini-3.5-flash",
    });
    const callPart = `{"functionCall":{"name":${JSON.stringify(plan.tool.name)},"args":${
      parsedArguments !== null ? JSON.stringify(parsedArguments) : argumentsText
    }}}`;
    const usage = plan.usage
      ? `,"usageMetadata":{"promptTokenCount":${plan.usage.inputTokens},"candidatesTokenCount":${plan.usage.outputTokens},"totalTokenCount":${plan.usage.inputTokens + plan.usage.outputTokens}}`
      : "";
    const callEvent = `data: {"candidates":[{"content":{"role":"model","parts":[${callPart}]},"finishReason":"STOP","index":0}]${usage},"responseId":"resp_fault","modelVersion":"gemini-3.5-flash"}\n\n`;
    const frames = [textEvent, callEvent];
    return { frames, truncatedMidToolCall: [textEvent, halfOf(callEvent)] };
  },
};

export const OPENAI_CHAT_WIRE: ProviderWire = {
  contentType: "text/event-stream",
  reply(plan) {
    const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
      dataEvent({
        id: "chatcmpl-fault",
        object: "chat.completion.chunk",
        created: 1_790_000_000,
        model: "fault-model",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      });
    const frames = [
      chunk({ role: "assistant", content: plan.text }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: plan.tool.callId,
            type: "function",
            function: { name: plan.tool.name, arguments: "" },
          },
        ],
      }),
    ];
    const firstArgumentFrame = frames.length;
    for (const piece of plan.tool.argumentChunks) {
      frames.push(chunk({ tool_calls: [{ index: 0, function: { arguments: piece } }] }));
    }
    frames.push(chunk({}, "tool_calls"));
    if (plan.usage) {
      frames.push(
        dataEvent({
          id: "chatcmpl-fault",
          object: "chat.completion.chunk",
          choices: [],
          usage: {
            prompt_tokens: plan.usage.inputTokens,
            completion_tokens: plan.usage.outputTokens,
            total_tokens: plan.usage.inputTokens + plan.usage.outputTokens,
          },
        }),
      );
    }
    frames.push(dataEvent("[DONE]"));
    return { frames, truncatedMidToolCall: frames.slice(0, firstArgumentFrame + 1) };
  },
};

/**
 * Ollama sends each tool call whole in one NDJSON line; its arguments are
 * normally an object, and a string is parsed (so a broken string is the
 * malformed case).
 */
export const OLLAMA_WIRE: ProviderWire = {
  contentType: "application/x-ndjson",
  reply(plan) {
    const argumentsText = plan.tool.argumentChunks.join("");
    let argumentsValue: unknown = argumentsText;
    try {
      argumentsValue = JSON.parse(argumentsText);
    } catch {
      /* malformed — sent as the raw string */
    }
    const line = (data: Record<string, unknown>) =>
      `${JSON.stringify({ model: "fault-model", created_at: "2026-09-23T00:00:00Z", ...data })}\n`;
    const textLine = line({ message: { role: "assistant", content: plan.text }, done: false });
    const callLine = line({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: plan.tool.name, arguments: argumentsValue } }],
      },
      done: false,
    });
    const doneLine = line({
      message: { role: "assistant", content: "" },
      done: true,
      done_reason: "stop",
      ...(plan.usage && {
        prompt_eval_count: plan.usage.inputTokens,
        eval_count: plan.usage.outputTokens,
        eval_duration: 1_000_000_000,
      }),
    });
    return {
      frames: [textLine, callLine, doneLine],
      truncatedMidToolCall: [textLine, halfOf(callLine)],
    };
  },
};
