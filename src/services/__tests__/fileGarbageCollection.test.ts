import { describe, it, expect } from "vitest";

import {
  extractReferencedKeys,
  isUploadKey,
} from "#src/services/FileGarbageCollectionService";
import { validateUploadDataUrl } from "#src/routes/FilesRoutes";

describe("extractReferencedKeys", () => {
  const bucketUrl = "https://minio.example.com:9000/prism";

  it("extracts minio:// refs from serialized documents", () => {
    const doc = JSON.stringify({
      messages: [
        { images: ["minio://projects/p/u/uploads/a.png"] },
        { pdf: ["minio://uploads/b.pdf"] },
      ],
    });
    expect(extractReferencedKeys(doc, null)).toEqual([
      "projects/p/u/uploads/a.png",
      "uploads/b.pdf",
    ]);
  });

  it("extracts direct bucket URLs and /files/ proxy URLs", () => {
    const doc = JSON.stringify({
      files: [
        { url: `${bucketUrl}/projects/p/u/uploads/c.csv` },
        { url: "https://prism.example.com/files/uploads/d.docx" },
      ],
    });
    const keys = extractReferencedKeys(doc, bucketUrl);
    expect(keys).toContain("projects/p/u/uploads/c.csv");
    expect(keys).toContain("uploads/d.docx");
  });

  it("ignores arbitrary /files/ strings outside known storage prefixes", () => {
    const doc = JSON.stringify({ text: "see /files/readme.txt for details" });
    expect(extractReferencedKeys(doc, null)).toEqual([]);
  });

  it("returns an empty list for documents without refs", () => {
    expect(extractReferencedKeys(JSON.stringify({ a: 1 }), bucketUrl)).toEqual(
      [],
    );
  });
});

describe("isUploadKey", () => {
  it("accepts flat and project-scoped upload keys", () => {
    expect(isUploadKey("uploads/x.png")).toBe(true);
    expect(isUploadKey("projects/p/u/uploads/x.png")).toBe(true);
  });

  it("rejects other categories", () => {
    expect(isUploadKey("projects/p/u/generations/x.png")).toBe(false);
    expect(isUploadKey("projects/p/u/screenshots/x.png")).toBe(false);
    expect(isUploadKey("generations/x.png")).toBe(false);
  });
});

describe("validateUploadDataUrl", () => {
  it("accepts allowlisted media and document types", () => {
    for (const dataUrl of [
      "data:image/png;base64,iVBORw0KGgo=",
      "data:audio/mpeg;base64,AAAA",
      "data:video/mp4;base64,AAAA",
      "data:application/pdf;base64,JVBERi0=",
      "data:text/plain;base64,aGVsbG8=",
      "data:text/csv;base64,YSxiLGM=",
      "data:application/json;base64,e30=",
      "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,UEsDBA==",
      "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,UEsDBA==",
    ]) {
      expect(validateUploadDataUrl(dataUrl), dataUrl).toBeNull();
    }
  });

  it("accepts iPhone photos (HEIC/HEIF) and SVG via the image/ prefix", () => {
    for (const dataUrl of [
      "data:image/heic;base64,AAAAGGZ0eXBoZWlj",
      "data:image/heif;base64,AAAAGGZ0eXBoZWlm",
      "data:image/svg+xml;base64,PHN2Zy8+",
    ]) {
      expect(validateUploadDataUrl(dataUrl), dataUrl).toBeNull();
    }
  });

  it("accepts any text/* plus common code/config MIME types", () => {
    for (const dataUrl of [
      "data:text/markdown;base64,IyBoaQ==",
      "data:text/html;base64,PGgxLz4=",
      "data:text/x-rust;base64,Zm4=",
      "data:application/javascript;base64,bGV0IHg=",
      "data:application/typescript;base64,bGV0IHg=",
      "data:application/x-yaml;base64,YTogMQ==",
      "data:application/xml;base64,PHhtbC8+",
      "data:application/x-sh;base64,ZWNobw==",
      "data:application/toml;base64,YSA9IDE=",
      "data:application/x-python-code;base64,cHJpbnQ=",
      "data:application/sql;base64,U0VMRUNU",
    ]) {
      expect(validateUploadDataUrl(dataUrl), dataUrl).toBeNull();
    }
  });

  it("still rejects application/octet-stream (client rewrites known text extensions)", () => {
    const error = validateUploadDataUrl(
      "data:application/octet-stream;base64,AAAA",
    );
    expect(error).toMatch(/application\/octet-stream/);
    expect(error).toMatch(/not allowed/);
  });

  it("rejects missing/non-string/empty payloads", () => {
    expect(validateUploadDataUrl(undefined)).toMatch(/non-empty string/);
    expect(validateUploadDataUrl(42)).toMatch(/non-empty string/);
    expect(validateUploadDataUrl("")).toMatch(/non-empty string/);
  });

  it("rejects non-data-URL strings", () => {
    expect(validateUploadDataUrl("https://example.com/a.png")).toMatch(
      /must be a data URL/,
    );
  });

  it("rejects non-base64 data URLs", () => {
    expect(validateUploadDataUrl("data:text/plain,hello")).toMatch(/base64/);
  });

  it("rejects disallowed MIME types with a clear message", () => {
    const error = validateUploadDataUrl(
      "data:application/x-msdownload;base64,TVqQ",
    );
    expect(error).toMatch(/application\/x-msdownload/);
    expect(error).toMatch(/not allowed/);
  });

  it("rejects data URLs with an empty body", () => {
    expect(validateUploadDataUrl("data:image/png;base64,")).toMatch(
      /no content/,
    );
  });

  it("rejects payloads whose decoded size exceeds 40 MB", () => {
    // 41 MB decoded → ~54.7M base64 chars. Build cheaply with repeat().
    const oversized = `data:image/png;base64,${"A".repeat(Math.ceil((41 * 1024 * 1024 * 4) / 3))}`;
    expect(validateUploadDataUrl(oversized)).toMatch(/too large/);
  });
});
