import { DOMAINS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import logger from "#src/utils/logger";
import AutoApprovalEngine from "#src/services/AutoApprovalEngine";
import { INTERNAL_TOOL_EMOJIS } from "#src/services/tool-orchestrator/InternalToolEmojis";
import {
  READ_UNTRUSTED_TOOL_NAME,
  resolveReaderSource,
  type ReaderFetchCall,
} from "#src/services/reader/ReaderSource";
import {
  READER_MAX_QUESTION_CHARACTERS,
  compileReaderSchema,
  readUntrustedContent,
} from "#src/services/reader/QuarantinedReader";
import type { ToolExecutionContext } from "#src/services/tool-orchestrator/types";
import type { InternalToolContext } from "./InternalToolRegistry.ts";

// ────────────────────────────────────────────────────────────
// ReadUntrustedTool — read_untrusted
// ────────────────────────────────────────────────────────────
// Reads a page, an MCP resource, a third-party-content tool's output or
// given text through the quarantined reader (reader/QuarantinedReader),
// and returns ONLY the reader's schema-valid JSON. The fetched text stays
// inside this call: it reaches the reader model and the request log, never
// the planner's context.
//
// Governance: the approval engine judges this call as the fetch it makes
// (ReaderSource), before it runs. Here the fetch must also be a tool this
// conversation has (its `enabledTools`), and a deny is re-checked against
// the run's rules, policies and mode — the same guard run_tool_program
// keeps around its nested calls.
// ────────────────────────────────────────────────────────────

type ReadContext = InternalToolContext & ToolExecutionContext;

/** An error string from the fetch is the source's words too — kept short. */
const MAX_SOURCE_ERROR_CHARACTERS = 300;

function refuse(error: string, message: string) {
  return { error, message };
}

function fetchRefusal(
  call: ReaderFetchCall,
  toolArguments: Record<string, unknown>,
  context: ReadContext,
): string | null {
  if (Array.isArray(context.enabledTools) && !context.enabledTools.includes(call.name)) {
    return `${call.name} is not enabled in this conversation — enable it first, then read through it.`;
  }
  const approval = new AutoApprovalEngine({
    policies: context._policies ?? [],
    permissionRules: context._permissionRules ?? null,
    permissionMode: context._permissionMode ?? null,
    fullAuto: context._autoApprove === true,
  }).check({ id: null, name: READ_UNTRUSTED_TOOL_NAME, args: toolArguments });
  if (approval.isDenied) return `${call.name} is denied: ${approval.reason}`;
  return null;
}

/** The fetch's output as text for the reader, or why there is none. */
function sourceText(result: unknown): { text: string } | { failure: string } {
  if (typeof result === "string") {
    return result.trim() ? { text: result } : { failure: "the source was empty" };
  }
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    if (typeof record.error === "string" && record.error) {
      return { failure: record.error.slice(0, MAX_SOURCE_ERROR_CHARACTERS) };
    }
  }
  if (result === null || result === undefined) return { failure: "the source returned nothing" };
  return { text: JSON.stringify(result, null, 1) };
}

async function fetchSource(
  call: ReaderFetchCall,
  context: ReadContext,
): Promise<{ text: string } | { failure: string }> {
  const { default: ToolOrchestratorService } = await import(
    "#src/services/tool-orchestrator/ToolOrchestratorService"
  );
  try {
    const result = await ToolOrchestratorService.executeTool(call.name, call.args, {
      ...context,
      _recursionDepth: (context._recursionDepth ?? 0) + 1,
    });
    return sourceText(result);
  } catch (error: unknown) {
    return { failure: errorMessage(error).slice(0, MAX_SOURCE_ERROR_CHARACTERS) };
  }
}

const readUntrusted = {
  name: READ_UNTRUSTED_TOOL_NAME,
  capabilities: [] as const,
  emoji: INTERNAL_TOOL_EMOJIS[READ_UNTRUSTED_TOOL_NAME],
  description:
    "Read untrusted content WITHOUT putting it in your context. A separate reader model with no tools reads " +
    "the source and answers your question as JSON that must validate against the schema you give; you get " +
    "back only that JSON, as { result }. Use it whenever you need facts from a web page, an email or message, " +
    "an MCP resource, or any other third-party text — rather than its exact wording. Give exactly one source: " +
    "`url` (a web page), `resource` ({ server_name, uri }), `tool` ({ name, arguments } of a tool that returns " +
    "third-party content, e.g. read_email) or `content` (text you already hold). Objects in the schema are " +
    "closed: keys it does not define are rejected. An answer that does not validate is retried once, then " +
    "returns { error, issues }. Call read_web_page / read_mcp_resource directly only when the user wants the " +
    "raw text.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "A web page to read (fetched with read_web_page)." },
      resource: {
        type: "object",
        description: "An MCP resource to read (fetched with read_mcp_resource).",
        properties: {
          server_name: { type: "string", description: "The MCP server that hosts the resource." },
          uri: { type: "string", description: "The resource URI." },
        },
        required: ["server_name", "uri"],
      },
      tool: {
        type: "object",
        description:
          "A tool whose output is third-party content (mail, messages, feeds, search results, MCP tools), and its arguments.",
        properties: {
          name: { type: "string", description: "The tool's name." },
          arguments: { type: "object", description: "The tool's arguments, as you would pass them to it." },
        },
        required: ["name"],
      },
      content: { type: "string", description: "Text to read that you already hold." },
      schema: {
        type: "object",
        description:
          "JSON Schema of the answer you want back, e.g. { \"type\": \"object\", \"properties\": { \"price\": { \"type\": \"number\" } }, \"required\": [\"price\"] }. Ask for the fields you need, not the text.",
      },
      question: { type: "string", description: "What to extract or answer from the content." },
    },
    required: ["schema", "question"],
  },
  display: {
    activeVerb: "Reading untrusted content",
    completedVerb: "Read untrusted content",
    subjectParam: "question",
    subjectFormat: "truncate" as const,
  },
  labels: ["research", "coding"],
  domain: DOMAINS.CORE_HARNESS.displayName,
  async execute(toolArguments: Record<string, unknown>, internalContext: InternalToolContext) {
    const context = internalContext as ReadContext;

    const question = typeof toolArguments.question === "string" ? toolArguments.question.trim() : "";
    if (!question) return refuse("invalid_request", "question must be a non-empty string.");
    if (question.length > READER_MAX_QUESTION_CHARACTERS) {
      return refuse(
        "invalid_request",
        `question is ${question.length} characters; the limit is ${READER_MAX_QUESTION_CHARACTERS}.`,
      );
    }
    // A bad schema costs no fetch and no model call.
    const compiled = compileReaderSchema(toolArguments.schema);
    if (!compiled.ok) return refuse("invalid_schema", compiled.message);

    const resolved = resolveReaderSource(toolArguments);
    if (!resolved.ok) return refuse("invalid_request", resolved.message);
    const { source } = resolved;

    let content: string;
    if (source.kind === "fetch") {
      const refusal = fetchRefusal(source.call, toolArguments, context);
      if (refusal) return refuse("tool_not_allowed", refusal);
      const fetched = await fetchSource(source.call, context);
      if ("failure" in fetched) {
        return refuse("source_failed", `${source.call.name} failed: ${fetched.failure}`);
      }
      content = fetched.text;
    } else {
      content = source.content;
    }

    const outcome = await readUntrustedContent({
      content,
      sourceLabel: source.label,
      schema: toolArguments.schema as Record<string, unknown>,
      question,
      caller: {
        project: context.project,
        username: context.username,
        agent: context.agent,
        traceId: context.traceId,
        conversationId: context.conversationId,
        agentConversationId: context.agentConversationId,
        signal: context.signal,
      },
    });
    if (!outcome.ok) {
      return {
        error: outcome.error,
        message: outcome.message,
        ...(outcome.issues && { issues: outcome.issues }),
      };
    }
    logger.info(
      `[read_untrusted] ${source.label.slice(0, 120)} → ${outcome.provider}/${outcome.model} (attempt ${outcome.attempts})`,
    );
    return { result: outcome.data };
  },
};

export default readUntrusted;
