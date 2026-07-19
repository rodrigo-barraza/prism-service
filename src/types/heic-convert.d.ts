// Type declaration for the `heic-convert` package (no bundled types).
// Pure-JS HEIC/HEIF decoder (libheif-js WASM) + JPEG/PNG encoder — used
// because sharp's prebuilt binaries omit the patent-encumbered HEVC codec.
declare module "heic-convert" {
  interface HeicConvertOptions {
    buffer: Buffer | Uint8Array;
    format: "JPEG" | "PNG";
    /** JPEG quality 0–1. Ignored for PNG. */
    quality?: number;
  }
  function convert(options: HeicConvertOptions): Promise<ArrayBuffer>;
  export default convert;
}
