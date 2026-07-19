/**
 * Unit tests for the document attachment context cache.
 *
 * Small text-like documents (text/*, JSON, code MIME types) under 256 KB
 * inline their content for providers; binary or oversized documents keep
 * the reader-tool pointer. Content is primed once (async) and read
 * synchronously by payload builders; results must be byte-stable across
 * turns for prompt-cache stability.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  SMALL_DOCUMENT_INLINE_MAX_BYTES,
  buildDocumentPointerText,
  clearDocumentContextCache,
  getDocumentContextText,
  isTextLikeDocumentMime,
  primeDocumentContext,
} from "#src/utils/documentContext";

function stubFetch(options: {
  contentType?: string | null;
  body?: string | Buffer;
  ok?: boolean;
  status?: number;
  contentLength?: number;
}) {
  const {
    contentType = "text/plain",
    body = "",
    ok = true,
    status = 200,
  } = options;
  const fetchSpy = vi.fn().mockResolvedValue({
    ok,
    status,
    headers: {
      get: (name: string) => {
        if (name === "content-type") return contentType;
        if (name === "content-length")
          return options.contentLength !== undefined
            ? String(options.contentLength)
            : null;
        return null;
      },
    },
    arrayBuffer: async () => Buffer.from(body),
    body: undefined,
  });
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

describe("isTextLikeDocumentMime", () => {
  it("accepts text/* and code/config MIME types", () => {
    for (const mime of [
      "text/plain",
      "text/markdown",
      "text/x-rust",
      "application/json",
      "application/javascript",
      "application/typescript",
      "application/x-yaml",
      "application/xml",
      "application/x-sh",
      "application/toml",
      "application/x-python-code",
      "text/csv; charset=utf-8",
    ]) {
      expect(isTextLikeDocumentMime(mime), mime).toBe(true);
    }
  });

  it("rejects binary document formats (DOCX/XLSX/PDF/octet-stream)", () => {
    for (const mime of [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/octet-stream",
      "image/png",
    ]) {
      expect(isTextLikeDocumentMime(mime), mime).toBe(false);
    }
  });
});

describe("primeDocumentContext + getDocumentContextText", () => {
  beforeEach(() => {
    clearDocumentContextCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to the reader-tool pointer for unprimed references", () => {
    const reference = "https://minio.example.com/bucket/uploads/data.csv";
    expect(getDocumentContextText(reference)).toBe(
      buildDocumentPointerText(reference),
    );
    expect(getDocumentContextText(reference)).toContain("read_csv");
  });

  it("inlines small text data URIs with name, mime, and size header", async () => {
    const content = "hello,world\n1,2";
    const reference = `data:text/csv;base64,${Buffer.from(content).toString("base64")}`;
    await primeDocumentContext(reference);
    const text = getDocumentContextText(reference);
    expect(text).toContain('[Attached file "attachment" (text/csv, 0.0 KB)]');
    expect(text).toContain(content);
  });

  it("keeps the pointer for binary data URIs", async () => {
    const reference = "data:application/pdf;base64,JVBERi0=";
    await primeDocumentContext(reference);
    expect(getDocumentContextText(reference)).toBe(
      buildDocumentPointerText(reference),
    );
  });

  it("keeps the pointer for oversized text data URIs", async () => {
    const big = "x".repeat(SMALL_DOCUMENT_INLINE_MAX_BYTES + 1);
    const reference = `data:text/plain;base64,${Buffer.from(big).toString("base64")}`;
    await primeDocumentContext(reference);
    expect(getDocumentContextText(reference)).toBe(
      buildDocumentPointerText(reference),
    );
  });

  it("fetches http references once and inlines small text documents", async () => {
    const fetchSpy = stubFetch({
      contentType: "text/markdown; charset=utf-8",
      body: "# Notes\nSome content",
    });
    const reference = "https://minio.example.com/bucket/uploads/notes.md";
    await primeDocumentContext(reference);
    await primeDocumentContext(reference); // cached — no second fetch
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const text = getDocumentContextText(reference);
    expect(text).toContain('"notes.md"');
    expect(text).toContain("text/markdown");
    expect(text).toContain("# Notes");
  });

  it("recovers the MIME type from the extension when the server returns octet-stream", async () => {
    stubFetch({
      contentType: "application/octet-stream",
      body: "print('hi')",
    });
    const reference = "https://example.com/files/script.py";
    await primeDocumentContext(reference);
    const text = getDocumentContextText(reference);
    expect(text).toContain("application/x-python-code");
    expect(text).toContain("print('hi')");
  });

  it("keeps the pointer for http documents with binary content types", async () => {
    stubFetch({
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      body: "PK...",
    });
    const reference = "https://example.com/files/report.xlsx";
    await primeDocumentContext(reference);
    expect(getDocumentContextText(reference)).toBe(
      buildDocumentPointerText(reference),
    );
  });

  it("keeps the pointer when the declared content-length exceeds the inline limit", async () => {
    const fetchSpy = stubFetch({
      contentType: "text/plain",
      body: "irrelevant",
      contentLength: SMALL_DOCUMENT_INLINE_MAX_BYTES + 1,
    });
    const reference = "https://example.com/files/huge.log";
    await primeDocumentContext(reference);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(getDocumentContextText(reference)).toBe(
      buildDocumentPointerText(reference),
    );
  });

  it("does not cache transient fetch failures (retry next turn, pointer meanwhile)", async () => {
    const failSpy = stubFetch({ ok: false, status: 503 });
    const reference = "https://example.com/files/flaky.txt";
    await primeDocumentContext(reference);
    expect(getDocumentContextText(reference)).toBe(
      buildDocumentPointerText(reference),
    );
    // Next prime retries and succeeds
    stubFetch({ contentType: "text/plain", body: "recovered" });
    await primeDocumentContext(reference);
    expect(getDocumentContextText(reference)).toContain("recovered");
    expect(failSpy).toHaveBeenCalledTimes(1);
  });

  it("is byte-stable across turns — later remote changes do not alter the cached text", async () => {
    stubFetch({ contentType: "text/plain", body: "version one" });
    const reference = "https://example.com/files/stable.txt";
    await primeDocumentContext(reference);
    const first = getDocumentContextText(reference);
    // Remote content changes; the cache must keep the original bytes
    stubFetch({ contentType: "text/plain", body: "version two" });
    await primeDocumentContext(reference);
    expect(getDocumentContextText(reference)).toBe(first);
    expect(first).toContain("version one");
  });

  it("ignores non-fetchable references (minio://) — pointer fallback", async () => {
    const reference = "minio://bucket/uploads/data.csv";
    await primeDocumentContext(reference);
    expect(getDocumentContextText(reference)).toBe(
      buildDocumentPointerText(reference),
    );
  });
});
