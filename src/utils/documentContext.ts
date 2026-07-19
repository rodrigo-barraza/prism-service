// ─────────────────────────────────────────────────────────────
// Document Attachment Context
// ─────────────────────────────────────────────────────────────
// Providers historically emitted only a reader-tool pointer for
// `documents` attachments. Small text-like documents (source code, JSON,
// CSV, config files …) are now inlined directly into the prompt as
//   [Attached file "name" (mime, N KB)]\n<content>
// while large or binary documents (DOCX/XLSX/PDF…) keep the pointer.
//
// Content is fetched ONCE at media-resolution time (primeDocumentContext,
// async — see MediaResolutionService.resolveDocumentReference) and cached
// in-memory so the provider payload builders — several of which are
// synchronous — can read it with getDocumentContextText. The cache is
// keyed by the resolved reference and the formatted text is deterministic,
// keeping provider payloads byte-identical across turns (prompt-cache
// stability, same concern as video frames / HEIC conversion).

import logger from "./logger.ts";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { ENCODINGS } from "#src/constants";

/** Text-like documents up to this decoded size are inlined; larger ones keep the pointer. */
export const SMALL_DOCUMENT_INLINE_MAX_BYTES = 256 * 1024;

const DOCUMENT_CONTEXT_CACHE_MAX_ENTRIES = 64;
const documentContextCache = new Map<string, string>();

/** Code/config MIME types treated as inlineable text (besides the text/* prefix). */
const TEXT_LIKE_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/json5",
  "application/xml",
  "application/xhtml+xml",
  "application/javascript",
  "application/x-javascript",
  "application/ecmascript",
  "application/typescript",
  "application/x-typescript",
  "application/x-yaml",
  "application/yaml",
  "application/toml",
  "application/x-toml",
  "application/x-sh",
  "application/x-shellscript",
  "application/x-python-code",
  "application/x-python",
  "application/sql",
  "application/graphql",
  "application/x-httpd-php",
  "application/csv",
]);

/** Extension → MIME fallbacks for servers that return generic content types. */
const EXTENSION_MIME_FALLBACKS: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  xml: "application/xml",
  yaml: "application/x-yaml",
  yml: "application/x-yaml",
  toml: "application/toml",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "application/javascript",
  mjs: "application/javascript",
  cjs: "application/javascript",
  jsx: "application/javascript",
  ts: "application/typescript",
  tsx: "application/typescript",
  py: "application/x-python-code",
  sh: "application/x-sh",
  sql: "application/sql",
  log: "text/plain",
  ini: "text/plain",
  conf: "text/plain",
  env: "text/plain",
};

/** Whether a MIME type is text-like enough to inline (never DOCX/XLSX/PDF). */
export function isTextLikeDocumentMime(mimeType: string): boolean {
  const normalized = mimeType.split(";")[0].trim().toLowerCase();
  return (
    normalized.startsWith("text/") || TEXT_LIKE_MIME_TYPES.has(normalized)
  );
}

/**
 * Reader-tool pointer for documents that are not inlined (binary formats,
 * oversized text, unprimed references). Wording shared across providers.
 */
export function buildDocumentPointerText(reference: string): string {
  return `[Attached document: ${reference.startsWith("data:") ? "(data URI)" : reference.substring(0, 200)} — use a document reader tool (read_csv, read_docx, read_spreadsheet, read_pdf) with "attached" to read it.]`;
}

/** Deterministic inline rendering of a small text document. */
export function formatInlineDocumentText(
  name: string,
  mimeType: string,
  sizeBytes: number,
  content: string,
): string {
  const kilobytes = (sizeBytes / 1024).toFixed(1);
  return `[Attached file "${name}" (${mimeType}, ${kilobytes} KB)]\n${content}`;
}

/** Best-effort display name from a URL path (falls back to "attachment"). */
function documentNameFromReference(reference: string): string {
  try {
    const pathname = new URL(reference).pathname;
    const basename = decodeURIComponent(pathname.split("/").pop() || "");
    if (basename) return basename;
  } catch {
    /* not a URL */
  }
  return "attachment";
}

function setCached(reference: string, text: string): void {
  documentContextCache.delete(reference);
  documentContextCache.set(reference, text);
  while (documentContextCache.size > DOCUMENT_CONTEXT_CACHE_MAX_ENTRIES) {
    const oldestKey = documentContextCache.keys().next().value as string;
    documentContextCache.delete(oldestKey);
  }
}

/**
 * Fetch and cache the provider-facing text for one document reference.
 * Small text-like documents cache their inlined content; binary or
 * oversized documents cache the reader-tool pointer. Transient fetch
 * failures cache NOTHING so a later turn can retry (the sync getter
 * falls back to the pointer meanwhile).
 */
export async function primeDocumentContext(reference: string): Promise<void> {
  if (typeof reference !== "string" || reference.length === 0) return;
  if (documentContextCache.has(reference)) {
    // Refresh LRU position
    setCached(reference, documentContextCache.get(reference) as string);
    return;
  }
  try {
    // data: URI — decode directly (MinIO-unavailable fallback path)
    if (reference.startsWith("data:")) {
      const base64Marker = ";base64,";
      const markerIndex = reference.indexOf(base64Marker);
      if (markerIndex === -1) return;
      const mimeType = reference
        .slice(5, markerIndex)
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (!isTextLikeDocumentMime(mimeType)) {
        setCached(reference, buildDocumentPointerText(reference));
        return;
      }
      const decoded = Buffer.from(
        reference.slice(markerIndex + base64Marker.length),
        ENCODINGS.BASE64,
      );
      if (decoded.length > SMALL_DOCUMENT_INLINE_MAX_BYTES) {
        setCached(reference, buildDocumentPointerText(reference));
        return;
      }
      setCached(
        reference,
        formatInlineDocumentText(
          "attachment",
          mimeType,
          decoded.length,
          decoded.toString("utf-8"),
        ),
      );
      return;
    }

    // Only http(s) references are fetchable; everything else (minio://,
    // ftp://…) stays on the pointer fallback in the getter.
    if (!/^https?:\/\//.test(reference)) return;

    const name = documentNameFromReference(reference);
    const extension = name.includes(".")
      ? (name.split(".").pop() as string).toLowerCase()
      : "";
    const response = await fetch(reference);
    if (!response.ok) {
      logger.warn(
        `[documents] Failed to fetch document for inlining (${response.status}): ${reference.substring(0, 120)}`,
      );
      return; // transient — do not cache
    }
    let mimeType = (response.headers.get("content-type") || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (
      (!mimeType ||
        mimeType === "application/octet-stream" ||
        mimeType === "binary/octet-stream") &&
      EXTENSION_MIME_FALLBACKS[extension]
    ) {
      mimeType = EXTENSION_MIME_FALLBACKS[extension];
    }
    if (!isTextLikeDocumentMime(mimeType)) {
      void response.body?.cancel().catch(() => {});
      setCached(reference, buildDocumentPointerText(reference));
      return;
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > SMALL_DOCUMENT_INLINE_MAX_BYTES
    ) {
      void response.body?.cancel().catch(() => {});
      setCached(reference, buildDocumentPointerText(reference));
      return;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > SMALL_DOCUMENT_INLINE_MAX_BYTES) {
      setCached(reference, buildDocumentPointerText(reference));
      return;
    }
    setCached(
      reference,
      formatInlineDocumentText(
        name,
        mimeType,
        bytes.length,
        bytes.toString("utf-8"),
      ),
    );
    logger.info(
      `[documents] Inlined small text document "${name}" (${mimeType}, ${(bytes.length / 1024).toFixed(1)} KB)`,
    );
  } catch (error: unknown) {
    logger.warn(
      `[documents] Failed to prime document context for ${reference.substring(0, 120)}: ${getErrorMessage(error)}`,
    );
  }
}

/**
 * Provider-facing text for a document reference: the primed inline
 * content when available, otherwise the reader-tool pointer. Synchronous
 * so sync payload builders (openai, openai-compat) can use it.
 */
export function getDocumentContextText(reference: string): string {
  const cached = documentContextCache.get(reference);
  if (cached) {
    setCached(reference, cached); // refresh LRU position
    return cached;
  }
  return buildDocumentPointerText(reference);
}

/** Test hook — clear the cached document context entries. */
export function clearDocumentContextCache(): void {
  documentContextCache.clear();
}
