import { describe, it, expect, vi, beforeAll } from 'vitest';
import sharp from 'sharp';
import {
  getDataUrlMimeType,
  getUrlType,
  inferMimeFromUrl,
  constrainImageDimensions,
  compressImageForSizeLimit,
  extractVideoFrames,
} from '../media.ts';
import { TYPES } from "../../constants.ts";

vi.mock('../logger.ts', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('getDataUrlMimeType', () => {
  it('extracts image/png from a PNG data URL', () => {
    expect(getDataUrlMimeType('data:image/png;base64,iVBOR...')).toBe('image/png');
  });

  it('extracts image/jpeg from a JPEG data URL', () => {
    expect(getDataUrlMimeType('data:image/jpeg;base64,/9j/4AAQ...')).toBe('image/jpeg');
  });

  it('extracts image/webp from a WebP data URL', () => {
    expect(getDataUrlMimeType('data:image/webp;base64,UklGR...')).toBe('image/webp');
  });

  it('extracts image/gif from a GIF data URL', () => {
    expect(getDataUrlMimeType('data:image/gif;base64,R0lGOD...')).toBe('image/gif');
  });

  it('extracts audio/mp3 from an MP3 data URL', () => {
    expect(getDataUrlMimeType('data:audio/mp3;base64,SUQz...')).toBe('audio/mp3');
  });

  it('extracts audio/wav from a WAV data URL', () => {
    expect(getDataUrlMimeType('data:audio/wav;base64,UklGR...')).toBe('audio/wav');
  });

  it('extracts audio/ogg from an OGG data URL', () => {
    expect(getDataUrlMimeType('data:audio/ogg;base64,T2dn...')).toBe('audio/ogg');
  });

  it('extracts video/mp4 from an MP4 data URL', () => {
    expect(getDataUrlMimeType('data:video/mp4;base64,AAAA...')).toBe('video/mp4');
  });

  it('extracts video/webm from a WebM data URL', () => {
    expect(getDataUrlMimeType('data:video/webm;base64,GkXf...')).toBe('video/webm');
  });

  it('extracts application/pdf from a PDF data URL', () => {
    expect(getDataUrlMimeType('data:application/pdf;base64,JVBERi0...')).toBe('application/pdf');
  });

  it('returns null for a non-data URL', () => {
    expect(getDataUrlMimeType('https://example.com/image.png')).toBeNull();
  });

  it('returns null for an invalid data URL format', () => {
    expect(getDataUrlMimeType('data:invalidformat')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(getDataUrlMimeType('')).toBeNull();
  });

  it('returns null for a data URL without base64 encoding marker', () => {
    expect(getDataUrlMimeType('data:text/plain,hello%20world')).toBeNull();
  });

  it('returns null for data URLs with extra parameters between mime and base64 (regex limitation)', () => {
    expect(getDataUrlMimeType('data:text/html;charset=utf-8;base64,PGh0bWw+')).toBeNull();
  });
});

describe('getUrlType', () => {
  it('returns "data" for data URLs', () => {
    expect(getUrlType('data:image/png;base64,abc')).toBe('data');
  });

  it('returns "http" for http:// URLs', () => {
    expect(getUrlType('http://example.com/image.png')).toBe('http');
  });

  it('returns "http" for https:// URLs', () => {
    expect(getUrlType('https://example.com/image.png')).toBe('http');
  });

  it('returns "any" for unsupported schemes', () => {
    expect(getUrlType('ftp://example.com/file')).toBe('any');
  });

  it('returns "any" for relative paths', () => {
    expect(getUrlType('/images/photo.jpg')).toBe('any');
  });

  it('returns "any" for empty strings', () => {
    expect(getUrlType('')).toBe('any');
  });
});

describe('inferMimeFromUrl', () => {
  it('returns "image" for image file extensions', () => {
    expect(inferMimeFromUrl('https://example.com/photo.jpg')).toBe(TYPES.IMAGE);
    expect(inferMimeFromUrl('https://example.com/photo.jpeg')).toBe(TYPES.IMAGE);
    expect(inferMimeFromUrl('https://example.com/photo.png')).toBe(TYPES.IMAGE);
    expect(inferMimeFromUrl('https://example.com/photo.gif')).toBe(TYPES.IMAGE);
    expect(inferMimeFromUrl('https://example.com/photo.webp')).toBe(TYPES.IMAGE);
    expect(inferMimeFromUrl('https://example.com/photo.bmp')).toBe(TYPES.IMAGE);
    expect(inferMimeFromUrl('https://example.com/photo.svg')).toBe(TYPES.IMAGE);
    expect(inferMimeFromUrl('https://example.com/photo.avif')).toBe(TYPES.IMAGE);
  });

  it('returns "image" with case-insensitive extension matching', () => {
    expect(inferMimeFromUrl('https://example.com/PHOTO.JPG')).toBe(TYPES.IMAGE);
    expect(inferMimeFromUrl('https://example.com/image.PNG')).toBe(TYPES.IMAGE);
  });

  it('returns "pdf" for PDF files', () => {
    expect(inferMimeFromUrl('https://example.com/document.pdf')).toBe(TYPES.PDF);
  });

  it('returns "text" for text-based file extensions', () => {
    expect(inferMimeFromUrl('https://example.com/readme.txt')).toBe(TYPES.TEXT);
    expect(inferMimeFromUrl('https://example.com/readme.md')).toBe(TYPES.TEXT);
    expect(inferMimeFromUrl('https://example.com/data.csv')).toBe(TYPES.TEXT);
    expect(inferMimeFromUrl('https://example.com/data.json')).toBe(TYPES.TEXT);
    expect(inferMimeFromUrl('https://example.com/page.html')).toBe(TYPES.TEXT);
    expect(inferMimeFromUrl('https://example.com/style.css')).toBe(TYPES.TEXT);
    expect(inferMimeFromUrl('https://example.com/script.js')).toBe(TYPES.TEXT);
    expect(inferMimeFromUrl('https://example.com/module.ts')).toBe(TYPES.TEXT);
  });

  it('returns "any" for URLs without recognized extensions', () => {
    expect(inferMimeFromUrl('https://example.com/api/data')).toBe('any');
  });

  it('returns "any" for URLs with unknown extensions', () => {
    expect(inferMimeFromUrl('https://example.com/file.xyz')).toBe('any');
  });

  it('returns "any" for completely invalid URLs', () => {
    expect(inferMimeFromUrl('not-a-url')).toBe('any');
  });

  it('returns "any" for audio extensions (not handled by the source)', () => {
    expect(inferMimeFromUrl('https://example.com/track.mp3')).toBe('any');
    expect(inferMimeFromUrl('https://example.com/sound.wav')).toBe('any');
    expect(inferMimeFromUrl('https://example.com/audio.ogg')).toBe('any');
  });

  it('returns "any" for video extensions (not handled by the source)', () => {
    expect(inferMimeFromUrl('https://example.com/clip.mp4')).toBe('any');
    expect(inferMimeFromUrl('https://example.com/video.webm')).toBe('any');
  });

  it('correctly identifies extensions on URLs with hash fragments', () => {
    expect(inferMimeFromUrl('https://example.com/readme.md#section-1')).toBe(TYPES.TEXT);
  });
});

describe("sharp image utilities", () => {
  let smallPngBase64: string;
  let largePngBase64: string;
  let smallGifBase64: string;

  beforeAll(async () => {
    const smallPngBuffer = await sharp({
      create: {
        width: 10,
        height: 10,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 1 }
      }
    }).png().toBuffer();
    smallPngBase64 = smallPngBuffer.toString("base64");

    const largePngBuffer = await sharp({
      create: {
        width: 2500,
        height: 2500,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 1 }
      }
    }).png().toBuffer();
    largePngBase64 = largePngBuffer.toString("base64");

    const smallGifBuffer = await sharp({
      create: {
        width: 5,
        height: 5,
        channels: 4,
        background: { r: 0, g: 255, b: 0, alpha: 1 }
      }
    }).gif().toBuffer();
    smallGifBase64 = smallGifBuffer.toString("base64");
  });

  describe("constrainImageDimensions", () => {

    it("should return the original image if dimensions are within limit", async () => {
      const result = await constrainImageDimensions(smallPngBase64, "image/png", 2000);
      expect(result.data).toBe(smallPngBase64);
      expect(result.mediaType).toBe("image/png");
    });

    it("should resize a large image to stay within max dimension", async () => {
      const result = await constrainImageDimensions(largePngBase64, "image/png", 2000);
      expect(result.data).not.toBe(largePngBase64);
      expect(result.mediaType).toBe("image/png");

      const resizedBuffer = Buffer.from(result.data, "base64");
      const metadata = await sharp(resizedBuffer).metadata();
      expect(metadata.width).toBeLessThanOrEqual(2000);
      expect(metadata.height).toBeLessThanOrEqual(2000);
    });

    it("should bypass resizing for GIF images since ffmpeg/GIF progressive resize handles them", async () => {
      const result = await constrainImageDimensions(smallGifBase64, "image/gif", 2000);
      expect(result.data).toBe(smallGifBase64);
      expect(result.mediaType).toBe("image/gif");
    });

    it("should handle sharp parsing errors gracefully and return original base64", async () => {
      const invalidBase64 = "invalid-base64-data";
      const result = await constrainImageDimensions(invalidBase64, "image/png", 2000);
      expect(result.data).toBe(invalidBase64);
      expect(result.mediaType).toBe("image/png");
    });
  });

  describe("compressImageForSizeLimit", () => {

    it("should return original if size is within limits", async () => {
      const result = await compressImageForSizeLimit(smallPngBase64, "image/png", 100 * 1024);
      expect(result.data).toBe(smallPngBase64);
      expect(result.mediaType).toBe("image/png");
    });

    it("should compress large image to JPEG if it exceeds limits", async () => {
      const result = await compressImageForSizeLimit(largePngBase64, "image/png", 500);
      expect(result.mediaType).toBe("image/jpeg");
      expect(result.data.length).toBeLessThan(largePngBase64.length);
    });

    it("should compress animated GIF if size exceeds limit", async () => {
      const result = await compressImageForSizeLimit(smallGifBase64, "image/gif", 5);
      expect(result.mediaType).toBe("image/gif");
    });
  });

  describe("extractVideoFrames", () => {

    it("should throw an error for invalid video data URL format", async () => {
      await expect(extractVideoFrames("not-a-data-url")).rejects.toThrow("Invalid video data URL format");
      await expect(extractVideoFrames("data:video/mp4;base64")).rejects.toThrow("Invalid video data URL format");
    });

    it("should fail gracefully when processing corrupt or empty base64 video data", async () => {
      const corruptVideoDataUrl = "data:video/mp4;base64,corruptbase64data";
      await expect(extractVideoFrames(corruptVideoDataUrl)).rejects.toThrow();
    });
  });
});

