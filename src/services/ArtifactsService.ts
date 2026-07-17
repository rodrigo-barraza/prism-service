import logger from "#src/utils/logger";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME } from "#config";
import { COLLECTIONS } from "#src/constants";
import { generateUUID, getErrorMessage } from "@rodrigo-barraza/utilities-library";

// ─── ArtifactsService — registry of everything the agent creates ───
//
// Two artifact sources feed the agent_artifacts collection:
//   "document" — markdown/html authored via the create_artifact /
//                update_artifact internal tools (content stored inline,
//                with capped version history for tool-driven edits).
//   "tool"     — visual outputs auto-captured by ToolOrchestratorService
//                whenever a tool result carries self-describing
//                display{kind,url} metadata (images, videos, audio,
//                embeds like diagrams/charts/3D scenes). Only the URL is
//                stored; the asset itself lives in MinIO or the
//                tools-service embed_assets store.
//
// Scoping matches the rest of Prism: project + username stamped from
// trusted context, never from model-supplied arguments.
// ─────────────────────────────────────────────────────────────────────

export const DOCUMENT_ARTIFACT_KINDS = ["markdown", "html"] as const;
export type DocumentArtifactKind = (typeof DOCUMENT_ARTIFACT_KINDS)[number];

export const MEDIA_ARTIFACT_KINDS = ["image", "video", "audio", "embed"] as const;
export type MediaArtifactKind = (typeof MEDIA_ARTIFACT_KINDS)[number];

export type ArtifactKind = DocumentArtifactKind | MediaArtifactKind;

export interface ArtifactVersion {
  content: string;
  title: string;
  updatedAt: Date;
}

export interface ArtifactDocument {
  id: string;
  project: string;
  username: string;
  agent?: string | null;
  conversationId?: string | null;
  agentConversationId?: string | null;
  source: "document" | "tool";
  kind: ArtifactKind;
  title: string;
  /** Inline body — document artifacts only. */
  content?: string;
  /** Asset URL — tool-captured media/embed artifacts only. */
  url?: string;
  /** Originating tool name — tool-captured artifacts only. */
  toolName?: string;
  /** Suggested iframe height from display metadata (embeds). */
  height?: number;
  version: number;
  /** Prior versions, most recent last — document artifacts only. */
  versions?: ArtifactVersion[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ArtifactProvenance {
  project?: string | null;
  username?: string | null;
  agent?: string | null;
  conversationId?: string | null;
  agentConversationId?: string | null;
}

/** Content guardrails — keep documents comfortably under Mongo's 16MB cap. */
export const ARTIFACT_MAX_CONTENT_CHARS = 1_000_000;
const MAX_VERSION_HISTORY = 10;
const MAX_TITLE_CHARS = 300;

function getDatabaseSafe() {
  try {
    return MongoWrapper.getDb(MONGO_DB_NAME);
  } catch {
    return null;
  }
}

function getArtifactsCollection() {
  const database = getDatabaseSafe();
  return database ? database.collection<ArtifactDocument>(COLLECTIONS.AGENT_ARTIFACTS) : null;
}

function normalizeTitle(title: unknown, fallback: string): string {
  const trimmed = typeof title === "string" ? title.trim() : "";
  if (!trimmed) return fallback;
  return trimmed.length > MAX_TITLE_CHARS ? `${trimmed.slice(0, MAX_TITLE_CHARS)}…` : trimmed;
}

function provenanceFields(provenance: ArtifactProvenance) {
  return {
    project: provenance.project || "unknown",
    username: provenance.username || "unknown",
    agent: provenance.agent ?? null,
    conversationId: provenance.conversationId ?? null,
    agentConversationId: provenance.agentConversationId ?? null,
  };
}

/** Humanize a tool name for use as a fallback artifact title: "generate_image" → "Generate image". */
function humanizeToolName(toolName: string): string {
  const words = toolName.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : toolName;
}

/**
 * Decide whether a tool result carries a gallery-worthy visual output,
 * and extract what would be registered. Pure — exported for tests.
 *
 * Eligible: display{kind: image|video|audio|embed, url} metadata, or a
 * post-hoc MinIO ref stamped by the orchestrator (generate_image). Only
 * durable references qualify — base64 payloads and non-URL values would
 * bloat the collection.
 */
export function extractCapturableArtifact(
  toolName: string,
  result: unknown,
): { kind: MediaArtifactKind; url: string; title: string; height?: number } | null {
  if (!result || typeof result !== "object") return null;
  const resultRecord = result as Record<string, unknown>;
  if (resultRecord.error) return null;

  const display = resultRecord.display as
    | { kind?: string; url?: string; title?: string; height?: number }
    | undefined;

  let kind: MediaArtifactKind | null = null;
  let url: string | null = null;
  let title: string | null = null;
  let height: number | undefined;

  if (
    display &&
    typeof display.url === "string" &&
    (MEDIA_ARTIFACT_KINDS as readonly string[]).includes(display.kind ?? "")
  ) {
    kind = display.kind as MediaArtifactKind;
    url = display.url;
    title = typeof display.title === "string" ? display.title : null;
    height = typeof display.height === "number" ? display.height : undefined;
  } else {
    // generate_image has no display metadata — the orchestrator uploads
    // the image to MinIO post-hoc and stamps image.minioRef.
    const image = resultRecord.image as { minioRef?: string } | undefined;
    if (image?.minioRef && typeof image.minioRef === "string") {
      kind = "image";
      url = image.minioRef;
    }
  }

  if (!kind || !url) return null;
  if (!/^(https?:\/\/|minio:\/\/)/.test(url)) return null;

  return {
    kind,
    url,
    title: normalizeTitle(title, humanizeToolName(toolName)),
    ...(height !== undefined && { height }),
  };
}

export default class ArtifactsService {
  // ─── Document artifacts (create_artifact / update_artifact) ─────

  static async createDocument(
    input: { title: string; kind: DocumentArtifactKind; content: string },
    provenance: ArtifactProvenance,
  ): Promise<ArtifactDocument> {
    const collection = getArtifactsCollection();
    if (!collection) throw new Error("Database unavailable");

    const now = new Date();
    const artifact: ArtifactDocument = {
      id: generateUUID(),
      ...provenanceFields(provenance),
      source: "document",
      kind: input.kind,
      title: normalizeTitle(input.title, "Untitled artifact"),
      content: input.content,
      version: 1,
      versions: [],
      createdAt: now,
      updatedAt: now,
    };

    await collection.insertOne(artifact);
    return artifact;
  }

  static async updateDocument(
    artifactId: string,
    updates: { content: string; title?: string },
    provenance: ArtifactProvenance,
  ): Promise<ArtifactDocument | null> {
    const collection = getArtifactsCollection();
    if (!collection) throw new Error("Database unavailable");

    const scope = provenanceFields(provenance);
    const existing = await collection.findOne({
      id: artifactId,
      project: scope.project,
      source: "document",
    });
    if (!existing) return null;

    const previousVersion: ArtifactVersion = {
      content: existing.content ?? "",
      title: existing.title,
      updatedAt: existing.updatedAt,
    };
    const versions = [...(existing.versions ?? []), previousVersion].slice(
      -MAX_VERSION_HISTORY,
    );

    const result = await collection.findOneAndUpdate(
      { id: artifactId, project: scope.project },
      {
        $set: {
          content: updates.content,
          title: normalizeTitle(updates.title, existing.title),
          version: existing.version + 1,
          versions,
          updatedAt: new Date(),
        },
      },
      { returnDocument: "after" },
    );
    return result ?? null;
  }

  // ─── Tool-output auto-capture ────────────────────────────────────

  /**
   * Register a visual tool result as an artifact. Fire-and-forget from
   * the orchestrator — never throws. Upserts by (project, url) so
   * iterative tools that rewrite a stable embed URL update one artifact
   * instead of accumulating duplicates.
   */
  static captureToolResult(
    toolName: string,
    result: unknown,
    provenance: ArtifactProvenance,
  ): void {
    ArtifactsService.#captureToolResult(toolName, result, provenance).catch(
      (error: unknown) =>
        logger.warn(
          `[Artifacts] Capture failed for ${toolName}: ${getErrorMessage(error)}`,
        ),
    );
  }

  static async #captureToolResult(
    toolName: string,
    result: unknown,
    provenance: ArtifactProvenance,
  ): Promise<void> {
    const capturable = extractCapturableArtifact(toolName, result);
    if (!capturable) return;

    const collection = getArtifactsCollection();
    if (!collection) return;

    const scope = provenanceFields(provenance);
    const now = new Date();
    await collection.updateOne(
      { project: scope.project, url: capturable.url },
      {
        $set: {
          ...scope,
          source: "tool",
          kind: capturable.kind,
          title: capturable.title,
          url: capturable.url,
          toolName,
          ...(capturable.height !== undefined && { height: capturable.height }),
          updatedAt: now,
        },
        $setOnInsert: { id: generateUUID(), version: 1, createdAt: now },
      },
      { upsert: true },
    );
  }

  // ─── Queries (REST + list_artifacts tool) ────────────────────────

  static async getById(
    artifactId: string,
    scope: { project: string },
  ): Promise<ArtifactDocument | null> {
    const collection = getArtifactsCollection();
    if (!collection) throw new Error("Database unavailable");
    return collection.findOne({ id: artifactId, project: scope.project });
  }

  static async list(options: {
    project: string;
    page: number;
    limit: number;
    kind?: ArtifactKind;
    source?: "document" | "tool";
    search?: string;
    conversationId?: string;
    from?: string;
    to?: string;
  }): Promise<{ data: ArtifactDocument[]; total: number }> {
    const collection = getArtifactsCollection();
    if (!collection) throw new Error("Database unavailable");

    const filter: Record<string, unknown> = { project: options.project };
    if (options.kind) filter.kind = options.kind;
    if (options.source) filter.source = options.source;
    if (options.conversationId) {
      filter.$or = [
        { conversationId: options.conversationId },
        { agentConversationId: options.conversationId },
      ];
    }
    if (options.search) {
      filter.$and = [
        {
          $or: [
            { title: { $regex: options.search, $options: "i" } },
            { toolName: { $regex: options.search, $options: "i" } },
          ],
        },
      ];
    }
    if (options.from || options.to) {
      const range: Record<string, unknown> = {};
      if (options.from) range.$gte = new Date(options.from);
      if (options.to) range.$lte = new Date(options.to);
      filter.createdAt = range;
    }

    const skip = (options.page - 1) * options.limit;
    const [total, data] = await Promise.all([
      collection.countDocuments(filter),
      collection
        .find(filter, {
          // List responses stay light: full document bodies (up to 1MB)
          // are replaced by a short preview; GET /artifacts/:id returns
          // the complete content + version history.
          projection: {
            _id: 0,
            id: 1,
            project: 1,
            username: 1,
            agent: 1,
            conversationId: 1,
            agentConversationId: 1,
            source: 1,
            kind: 1,
            title: 1,
            url: 1,
            toolName: 1,
            height: 1,
            version: 1,
            createdAt: 1,
            updatedAt: 1,
            preview: { $substrCP: [{ $ifNull: ["$content", ""] }, 0, 400] },
          },
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(options.limit)
        .toArray(),
    ]);
    return { data, total };
  }

  static async remove(
    artifactId: string,
    scope: { project: string; username: string },
  ): Promise<boolean> {
    const collection = getArtifactsCollection();
    if (!collection) throw new Error("Database unavailable");
    const result = await collection.deleteOne({
      id: artifactId,
      project: scope.project,
    });
    return result.deletedCount > 0;
  }
}
