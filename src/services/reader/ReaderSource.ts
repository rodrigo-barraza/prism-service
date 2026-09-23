import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";
import { LOCAL_TOOL_NAMES } from "#src/services/ToolTaxonomyConstants";
import { isExternalContentTool } from "#src/services/memory/MemoryProvenance";

// ────────────────────────────────────────────────────────────
// ReaderSource — what `read_untrusted` reads, and the call that fetches it
// ────────────────────────────────────────────────────────────
// A read names exactly one source:
//   url       → read_web_page({ url })
//   resource  → read_mcp_resource({ server_name, uri })
//   tool      → any tool whose output is third-party content (mail,
//               messages, feeds, MCP tools — isExternalContentTool)
//   content   → text the caller already holds
// The fetch runs inside read_untrusted, so its output never reaches the
// planner. It is still the fetch that acts on the world: the approval
// engine judges a read_untrusted call AS its fetch (AutoApprovalEngine),
// so a read that needs approval, a deny rule, or plan mode apply exactly
// as they would to the fetch called directly.
// ────────────────────────────────────────────────────────────

export const READ_UNTRUSTED_TOOL_NAME = LOCAL_TOOL_NAMES.READ_UNTRUSTED;

/**
 * External-content tools that act on a page rather than only read it. A
 * read has no business clicking.
 */
const NOT_A_READ = new Set<string>([
  TOOL_NAMES.CONTROL_BROWSER,
  "execute_browser_script",
]);

export interface ReaderFetchCall {
  name: string;
  args: Record<string, unknown>;
}

export type ReaderSource =
  | { kind: "content"; content: string; label: string }
  | { kind: "fetch"; call: ReaderFetchCall; label: string };

export type ReaderSourceResolution =
  | { ok: true; source: ReaderSource }
  | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function fetchSource(name: string, args: Record<string, unknown>, label: string): ReaderSourceResolution {
  return { ok: true, source: { kind: "fetch", call: { name, args }, label } };
}

/** The one source a read_untrusted call names, or why it names none. */
export function resolveReaderSource(args: Record<string, unknown>): ReaderSourceResolution {
  const url = nonEmptyString(args.url);
  const content = typeof args.content === "string" && args.content.length > 0 ? args.content : null;
  const resource = isRecord(args.resource) ? args.resource : null;
  const tool = isRecord(args.tool) ? args.tool : null;
  const named = [url, content, resource, tool].filter((source) => source !== null).length;
  if (named !== 1) {
    return {
      ok: false,
      message: `Give exactly one source — url, resource, tool or content (got ${named}).`,
    };
  }

  if (url) return fetchSource(TOOL_NAMES.READ_WEB_PAGE, { url }, url);

  if (resource) {
    const serverName = nonEmptyString(resource.server_name ?? resource.serverName);
    const uri = nonEmptyString(resource.uri);
    if (!serverName || !uri) {
      return { ok: false, message: "resource needs server_name and uri." };
    }
    return fetchSource(
      TOOL_NAMES.READ_MCP_RESOURCE,
      { server_name: serverName, uri },
      `${serverName}: ${uri}`,
    );
  }

  if (tool) {
    const name = nonEmptyString(tool.name);
    if (!name) return { ok: false, message: "tool needs a name." };
    if (name === READ_UNTRUSTED_TOOL_NAME) {
      return { ok: false, message: "read_untrusted cannot read through itself." };
    }
    if (NOT_A_READ.has(name)) {
      return { ok: false, message: `${name} acts on a page; read_untrusted only reads.` };
    }
    if (!isExternalContentTool(name)) {
      return {
        ok: false,
        message: `${name} does not return third-party content — call it directly.`,
      };
    }
    const toolArguments = isRecord(tool.arguments) ? tool.arguments : {};
    return fetchSource(name, toolArguments, name);
  }

  return { ok: true, source: { kind: "content", content: content!, label: "content" } };
}

/**
 * The call a read_untrusted call makes to fetch its source — what the
 * approval engine judges it as. `null` for any other tool, for `content`
 * (nothing is fetched), and for arguments that name no valid source (the
 * tool refuses those itself).
 */
export function readerFetchCall(toolCall: {
  name: string;
  args?: Record<string, unknown> | null;
}): ReaderFetchCall | null {
  if (toolCall.name !== READ_UNTRUSTED_TOOL_NAME) return null;
  const resolved = resolveReaderSource(toolCall.args ?? {});
  return resolved.ok && resolved.source.kind === "fetch" ? resolved.source.call : null;
}
