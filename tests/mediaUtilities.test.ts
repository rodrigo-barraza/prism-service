import { describe, it, expect, vi } from 'vitest';
import { getDataUrlMimeType, getUrlType, inferMimeFromUrl } from '../src/utils/media.ts';

vi.mock('../src/utils/logger.ts', () => ({
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
    expect(inferMimeFromUrl('https://example.com/photo.jpg')).toBe('image');
    expect(inferMimeFromUrl('https://example.com/photo.jpeg')).toBe('image');
    expect(inferMimeFromUrl('https://example.com/photo.png')).toBe('image');
    expect(inferMimeFromUrl('https://example.com/photo.gif')).toBe('image');
    expect(inferMimeFromUrl('https://example.com/photo.webp')).toBe('image');
    expect(inferMimeFromUrl('https://example.com/photo.bmp')).toBe('image');
    expect(inferMimeFromUrl('https://example.com/photo.svg')).toBe('image');
    expect(inferMimeFromUrl('https://example.com/photo.avif')).toBe('image');
  });

  it('returns "image" with case-insensitive extension matching', () => {
    expect(inferMimeFromUrl('https://example.com/PHOTO.JPG')).toBe('image');
    expect(inferMimeFromUrl('https://example.com/image.PNG')).toBe('image');
  });

  it('returns "pdf" for PDF files', () => {
    expect(inferMimeFromUrl('https://example.com/document.pdf')).toBe('pdf');
  });

  it('returns "text" for text-based file extensions', () => {
    expect(inferMimeFromUrl('https://example.com/readme.txt')).toBe('text');
    expect(inferMimeFromUrl('https://example.com/readme.md')).toBe('text');
    expect(inferMimeFromUrl('https://example.com/data.csv')).toBe('text');
    expect(inferMimeFromUrl('https://example.com/data.json')).toBe('text');
    expect(inferMimeFromUrl('https://example.com/page.html')).toBe('text');
    expect(inferMimeFromUrl('https://example.com/style.css')).toBe('text');
    expect(inferMimeFromUrl('https://example.com/script.js')).toBe('text');
    expect(inferMimeFromUrl('https://example.com/module.ts')).toBe('text');
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

  it('correctly identifies extensions on URLs with query strings', () => {
    expect(inferMimeFromUrl('https://cdn.example.com/photo.png?v=2&token=abc')).toBe('image');
    expect(inferMimeFromUrl('https://cdn.example.com/doc.pdf?download=true')).toBe('pdf');
  });

  it('correctly identifies extensions on URLs with hash fragments', () => {
    expect(inferMimeFromUrl('https://example.com/readme.md#section-1')).toBe('text');
  });
});
