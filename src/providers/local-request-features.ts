import logger from "#src/utils/logger";
import type { ProviderOptions } from "#src/types/provider";
import type { ProviderInstanceConfig } from "#src/types/ProviderTypes";
import { getModelProfile } from "#src/providers/ModelProfiles";
import { currentRequestPriority } from "#src/services/RequestPriority";

/**
 * Request features of the self-hosted runtimes, applied to a chat payload
 * right before it is sent.
 *
 * vLLM:
 *
 *   - strict tool arguments: on a model whose profile says vLLM constrains
 *     them (ModelProfiles `vllm_strict`), each function tool is marked
 *     `strict: true` — vLLM then enforces the tool's JSON schema on the call
 *     with structural tags even under tool_choice "auto" (vLLM tool-calling
 *     docs). Servers that predate it accept and ignore the field.
 *   - guided decoding for a JSON-schema response: `structured_outputs: {json}`
 *     on vLLM 0.12 and later, `guided_json` before it (removed in 0.12; a
 *     current server silently ignores it), by the server's /version.
 *   - request priority: on an instance started with --scheduling-policy
 *     priority (PROVIDER_VLLM_N_PRIORITY_SCHEDULING=true) a background
 *     utility call carries `X-Vllm-Priority: 10`, so interactive turns (0,
 *     the default) are served first. Never sent otherwise: a non-zero
 *     priority is an error on a server without priority scheduling.
 */

export const BACKGROUND_PRIORITY = 10;
const STRUCTURED_OUTPUTS_MIN_VERSION = [0, 12, 0];

const serverVersions = new Map<string, Promise<number[] | null>>();

/** Tests: forget every cached server version. */
export function _clearVllmVersions(): void {
  serverVersions.clear();
}

function parseVersion(text: unknown): number[] | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text ?? ""));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

function isOlder(version: number[], than: number[]): boolean {
  for (let index = 0; index < 3; index++) {
    if (version[index] !== than[index]) return version[index] < than[index];
  }
  return false;
}

/**
 * The JSON schema a request asks its response to follow: `json_schema`, or
 * `json_object` with a schema; an OpenAI-style `{name, schema}` wrapper is
 * unwrapped.
 */
export function requestedResponseSchema(options: ProviderOptions): Record<string, unknown> | null {
  const format = typeof options.responseFormat === "object" ? options.responseFormat?.type : options.responseFormat;
  if ((format !== "json_schema" && format !== "json_object") || !options.responseSchema) return null;
  const wrapped = options.responseSchema.schema;
  return wrapped && typeof wrapped === "object" ? (wrapped as Record<string, unknown>) : options.responseSchema;
}

/** The vLLM version a server reports (GET /version), cached per base URL; null when unknown. */
export function vllmServerVersion(baseUrl: string): Promise<number[] | null> {
  let pending = serverVersions.get(baseUrl);
  if (!pending) {
    pending = fetch(`${baseUrl}/version`, { signal: AbortSignal.timeout(3_000) })
      .then(async (response) => (response.ok ? parseVersion(((await response.json()) as { version?: string }).version) : null))
      .catch(() => null);
    serverVersions.set(baseUrl, pending);
  }
  return pending;
}

export interface VllmRequestContext {
  baseUrl: string;
  model: string;
  instanceId: string;
  options: ProviderOptions;
  config?: ProviderInstanceConfig;
}

/** Apply the vLLM features to `payload` in place; returns the extra request headers. */
export async function applyVllmRequestFeatures(
  payload: Record<string, unknown>,
  { baseUrl, model, instanceId, options, config }: VllmRequestContext,
): Promise<Record<string, string>> {
  const profile = getModelProfile(model, instanceId);

  if (profile.guidedToolArguments === "vllm_strict" && Array.isArray(payload.tools)) {
    payload.tools = (payload.tools as Array<Record<string, unknown>>).map((tool) =>
      tool.type === "function" && tool.function
        ? { ...tool, function: { ...(tool.function as Record<string, unknown>), strict: true } }
        : tool,
    );
  }

  const schema = requestedResponseSchema(options);
  if (schema) {
    const version = await vllmServerVersion(baseUrl);
    if (version && isOlder(version, STRUCTURED_OUTPUTS_MIN_VERSION)) {
      payload.guided_json = schema;
    } else {
      payload.structured_outputs = { json: schema };
    }
  }

  const headers: Record<string, string> = {};
  if (config?.priorityScheduling && currentRequestPriority() === "background") {
    headers["X-Vllm-Priority"] = String(BACKGROUND_PRIORITY);
    logger.debug(`[vLLM] ${instanceId}: background request, priority ${BACKGROUND_PRIORITY}`);
  }
  return headers;
}

/**
 * llama-server: a JSON-schema response is asked for with the OpenAI-style
 * `response_format` (llama-server turns the schema into a grammar). Tool
 * calls need nothing from us — started with --jinja, the server constrains
 * them with its own lazy grammar from the tools' schemas.
 */
export function llamaCppResponseFormat(options: ProviderOptions): Record<string, unknown> {
  const schema = requestedResponseSchema(options);
  return schema ? { response_format: { type: "json_schema", json_schema: { schema } } } : {};
}
