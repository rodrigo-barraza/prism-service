import { TOOL_NAMES, DOMAINS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { INTERNAL_TOOL_EMOJIS } from "#src/services/tool-orchestrator/InternalToolEmojis";
import type { InternalToolContext } from "./InternalToolRegistry.ts";

// ────────────────────────────────────────────────────────────
// Artifact tools — agent-authored standalone documents
// ────────────────────────────────────────────────────────────
// create_artifact / update_artifact / list_artifacts persist
// markdown or html documents to the agent_artifacts registry
// (ArtifactsService). The chat client renders them from the
// result's display { kind: "artifact", artifactId } metadata,
// and the /artifacts gallery lists them alongside auto-captured
// visual tool outputs (images, embeds, video, audio).
//
// Follows the document-tool pattern used by claude.ai Artifacts
// and ChatGPT Canvas: content travels as a tool argument, the
// harness owns storage/versioning/rendering, and updates are
// full-content rewrites keyed by artifactId.
// ────────────────────────────────────────────────────────────

const DOCUMENT_KINDS = ["markdown", "html"];

function provenanceFromContext(context: InternalToolContext) {
  return {
    project: context.project,
    username: context.username,
    agent: context.agent,
    conversationId: context.conversationId,
    agentConversationId: context.agentConversationId,
  };
}

const createArtifactTool = {
  name: TOOL_NAMES.CREATE_ARTIFACT,
  emoji: INTERNAL_TOOL_EMOJIS[TOOL_NAMES.CREATE_ARTIFACT],
  description:
    "Create a standalone document artifact (markdown or html) that is saved to the user's Artifacts gallery and rendered in the chat. " +
    "Use this for substantial, self-contained deliverables the user will want to keep, reference, or iterate on — reports, guides, specs, stories, styled pages. " +
    "Do NOT use it for ordinary conversational answers, short snippets, or explanations that belong in the chat itself. " +
    "html artifacts must be self-contained (inline CSS/JS, no external network dependencies) — they render in a sandboxed iframe. " +
    "Returns an artifactId; pass it to update_artifact to revise the document later.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Short human-readable document title, e.g. 'Q3 Marketing Plan'.",
      },
      kind: {
        type: "string",
        enum: DOCUMENT_KINDS,
        description:
          "Document format: 'markdown' for prose/reports (GFM, math, code blocks supported), 'html' for styled or interactive pages (self-contained, sandboxed).",
      },
      content: {
        type: "string",
        description: "The complete document body in the chosen format.",
      },
    },
    required: ["title", "kind", "content"],
  },
  display: {
    activeVerb: "Creating",
    completedVerb: "Created",
    subjectParam: "title",
    subjectFormat: "quoted" as const,
  },
  labels: ["artifacts", "documents", "creative"],
  domain: DOMAINS.CREATIVE.displayName,
  async execute(
    toolArguments: Record<string, unknown>,
    context: InternalToolContext,
  ) {
    const { default: ArtifactsService, ARTIFACT_MAX_CONTENT_CHARS } =
      await import("#src/services/ArtifactsService");

    const title =
      typeof toolArguments.title === "string" ? toolArguments.title.trim() : "";
    const kind =
      typeof toolArguments.kind === "string" ? toolArguments.kind : "";
    const content =
      typeof toolArguments.content === "string" ? toolArguments.content : "";

    if (!title) return { error: "title is required" };
    if (!DOCUMENT_KINDS.includes(kind)) {
      return { error: `kind must be one of: ${DOCUMENT_KINDS.join(", ")}` };
    }
    if (!content) return { error: "content is required" };
    if (content.length > ARTIFACT_MAX_CONTENT_CHARS) {
      return {
        error: `content exceeds the ${ARTIFACT_MAX_CONTENT_CHARS.toLocaleString()}-character limit — split the document into multiple artifacts`,
      };
    }

    const artifact = await ArtifactsService.createDocument(
      { title, kind: kind as "markdown" | "html", content },
      provenanceFromContext(context),
    );

    return {
      artifactId: artifact.id,
      title: artifact.title,
      kind: artifact.kind,
      version: artifact.version,
      status: "created",
      display: { kind: "artifact", artifactId: artifact.id, title: artifact.title },
    };
  },
};

const updateArtifactTool = {
  name: TOOL_NAMES.UPDATE_ARTIFACT,
  emoji: INTERNAL_TOOL_EMOJIS[TOOL_NAMES.UPDATE_ARTIFACT],
  description:
    "Replace the content of an existing document artifact with a new complete version (the previous version is kept in history). " +
    "Pass the artifactId returned by create_artifact or found via list_artifacts, plus the FULL revised document — not a diff or fragment. " +
    "Use this when the user asks to revise, extend, or fix a document you created earlier; do not create a duplicate artifact for a revision.",
  parameters: {
    type: "object",
    properties: {
      artifactId: {
        type: "string",
        description: "The id of the artifact to update.",
      },
      content: {
        type: "string",
        description: "The complete replacement document body.",
      },
      title: {
        type: "string",
        description: "Optional new title; omit to keep the current one.",
      },
    },
    required: ["artifactId", "content"],
  },
  display: {
    activeVerb: "Updating",
    completedVerb: "Updated",
    subjectParam: "artifactId",
    subjectFormat: "truncate" as const,
  },
  labels: ["artifacts", "documents", "creative"],
  domain: DOMAINS.CREATIVE.displayName,
  async execute(
    toolArguments: Record<string, unknown>,
    context: InternalToolContext,
  ) {
    const { default: ArtifactsService, ARTIFACT_MAX_CONTENT_CHARS } =
      await import("#src/services/ArtifactsService");

    const artifactId =
      typeof toolArguments.artifactId === "string"
        ? toolArguments.artifactId.trim()
        : "";
    const content =
      typeof toolArguments.content === "string" ? toolArguments.content : "";

    if (!artifactId) return { error: "artifactId is required" };
    if (!content) return { error: "content is required" };
    if (content.length > ARTIFACT_MAX_CONTENT_CHARS) {
      return {
        error: `content exceeds the ${ARTIFACT_MAX_CONTENT_CHARS.toLocaleString()}-character limit — split the document into multiple artifacts`,
      };
    }

    const artifact = await ArtifactsService.updateDocument(
      artifactId,
      {
        content,
        ...(typeof toolArguments.title === "string" && toolArguments.title.trim()
          ? { title: toolArguments.title.trim() }
          : {}),
      },
      provenanceFromContext(context),
    );

    if (!artifact) {
      return {
        error: `No document artifact found with id '${artifactId}' — use list_artifacts to find the right id`,
      };
    }

    return {
      artifactId: artifact.id,
      title: artifact.title,
      kind: artifact.kind,
      version: artifact.version,
      status: "updated",
      display: { kind: "artifact", artifactId: artifact.id, title: artifact.title },
    };
  },
};

const listArtifactsTool = {
  name: TOOL_NAMES.LIST_ARTIFACTS,
  emoji: INTERNAL_TOOL_EMOJIS[TOOL_NAMES.LIST_ARTIFACTS],
  description:
    "List recent artifacts in this project's gallery — agent-authored documents (markdown/html) and captured visual outputs (images, embeds, video, audio). " +
    "Use this to find an artifactId when the user refers to a document from an earlier conversation ('update that report from yesterday').",
  parameters: {
    type: "object",
    properties: {
      search: {
        type: "string",
        description: "Optional case-insensitive title filter.",
      },
      kind: {
        type: "string",
        enum: ["markdown", "html", "image", "video", "audio", "embed"],
        description: "Optional filter by artifact kind.",
      },
      limit: {
        type: "number",
        description: "Maximum results. Default: 20.",
      },
    },
  },
  display: {
    activeVerb: "Listing",
    completedVerb: "Listed",
    subjectParam: "search",
    subjectFormat: "quoted" as const,
  },
  labels: ["artifacts", "documents"],
  domain: DOMAINS.CREATIVE.displayName,
  async execute(
    toolArguments: Record<string, unknown>,
    context: InternalToolContext,
  ) {
    const { default: ArtifactsService } = await import(
      "#src/services/ArtifactsService"
    );

    const limit =
      typeof toolArguments.limit === "number" &&
      Number.isFinite(toolArguments.limit)
        ? Math.min(Math.max(Math.floor(toolArguments.limit), 1), 100)
        : 20;

    const { data, total } = await ArtifactsService.list({
      project: context.project || "unknown",
      page: 1,
      limit,
      ...(typeof toolArguments.search === "string" && toolArguments.search
        ? { search: toolArguments.search }
        : {}),
      ...(typeof toolArguments.kind === "string" && toolArguments.kind
        ? { kind: toolArguments.kind as import("#src/services/ArtifactsService").ArtifactKind }
        : {}),
    });

    return {
      total,
      artifacts: data.map((artifact) => ({
        artifactId: artifact.id,
        title: artifact.title,
        kind: artifact.kind,
        source: artifact.source,
        ...(artifact.toolName && { toolName: artifact.toolName }),
        ...(artifact.url && { url: artifact.url }),
        version: artifact.version,
        updatedAt: artifact.updatedAt,
      })),
    };
  },
};

const artifactTools = [createArtifactTool, updateArtifactTool, listArtifactsTool];

export default artifactTools;
