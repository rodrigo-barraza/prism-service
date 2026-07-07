import { describe, it, expect, vi, beforeEach } from "vitest";
import FileService from "#src/services/FileService";
import MinioWrapper from "#src/wrappers/MinioWrapper";
import { FILE_CATEGORIES, TYPES } from "#src/constants";

vi.mock("#src/wrappers/MinioWrapper", () => ({
  default: {
    isAvailable: vi.fn(),
    upload: vi.fn(),
    stat: vi.fn(),
    get: vi.fn(),
    init: vi.fn(),
    getPublicUrl: vi.fn(),
    remove: vi.fn(),
    listObjects: vi.fn(),
  },
}));

describe("FileService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("when MinIO is not available", () => {
    beforeEach(() => {
      vi.mocked(MinioWrapper.isAvailable).mockReturnValue(false);
    });

    it("returns the input data URL as reference unchanged", async () => {
      const dataUrl = "data:text/plain;base64,aGVsbG8=";
      const uploadResult = await FileService.uploadFile(dataUrl);
      expect(uploadResult.ref).toBe(dataUrl);
      expect(uploadResult.contentType).toBe("application/octet-stream");
    });
  });

  describe("when MinIO is available", () => {
    beforeEach(() => {
      vi.mocked(MinioWrapper.isAvailable).mockReturnValue(true);
      vi.mocked(MinioWrapper.upload).mockResolvedValue(undefined);
    });

    it("extracts content type and correctly maps to file extension on upload", async () => {
      const testCases = [
        {
          mimeType: "image/png",
          base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          expectedExtension: "png",
        },
        {
          mimeType: "audio/x-m4a",
          base64: "AAAAIGZ0eXBtcDRhAAAAAG1wNGEyYXBwbAACCm1vb3YAAABsbXZoZAAAAAD...",
          expectedExtension: "m4a",
        },
        {
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          base64: "UEsDBBQAAAAIAAAAAAD...",
          expectedExtension: "docx",
        },
        {
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          base64: "UEsDBBQAAAAIAAAAAAD...",
          expectedExtension: "xlsx",
        },
        {
          mimeType: "text/csv",
          base64: "Y29sdW1uMSxjb2x1bW4yCmEsYg==",
          expectedExtension: "csv",
        },
        {
          mimeType: "application/pdf",
          base64: "JVBERi0xLjQKJ...",
          expectedExtension: TYPES.PDF,
        },
      ];

      for (const testCase of testCases) {
        const dataUrl = `data:${testCase.mimeType};base64,${testCase.base64}`;
        const uploadResult = await FileService.uploadFile(
          dataUrl,
          FILE_CATEGORIES.UPLOADS,
          "test-project",
          "test-user"
        );

        expect(uploadResult.ref).toContain("minio://");
        expect(uploadResult.contentType).toBe(testCase.mimeType);

        // Verify key contains expected extension
        const uploadCallArguments = vi.mocked(MinioWrapper.upload).mock.calls;
        const lastUploadCall = uploadCallArguments[uploadCallArguments.length - 1];
        const uploadedKey = lastUploadCall[0];
        expect(uploadedKey.endsWith(`.${testCase.expectedExtension}`)).toBe(true);
        expect(uploadedKey).toContain("projects/test-project/test-user/uploads/");
      }
    });

    it("falls back to bin extension for unknown MIME types", async () => {
      const dataUrl = "data:application/unknown-mime;base64,aGVsbG8=";
      const uploadResult = await FileService.uploadFile(dataUrl);
      expect(uploadResult.ref).toContain("minio://");

      const uploadCallArguments = vi.mocked(MinioWrapper.upload).mock.calls;
      const lastUploadCall = uploadCallArguments[uploadCallArguments.length - 1];
      const uploadedKey = lastUploadCall[0];
      expect(uploadedKey.endsWith(".bin")).toBe(true);
    });
  });
});
