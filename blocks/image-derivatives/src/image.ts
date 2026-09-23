/**
 * Pure image inspection and metadata stripping. The decompression-bomb guard reads dimensions from
 * the file header WITHOUT decoding pixels — a 40KB PNG can declare 30000x30000 and exhaust memory
 * the instant it is decoded, which a byte limit does not catch. EXIF/GPS stripping is a privacy
 * requirement: a phone photo carries the coordinates it was taken at, and serving that with an
 * avatar leaks them.
 *
 * Both are pure and unit tested. The actual pixel resize is not here — it needs an image codec and
 * lives behind the Codec interface (see resize.ts), the way the AI blocks put the model behind a
 * provider.
 */

export interface Dimensions {
  width: number;
  height: number;
  format: "jpeg" | "png" | "gif" | "webp";
}

function u16be(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!;
}
function u32be(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}
function u32le(b: Uint8Array, o: number): number {
  return ((b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0);
}

/**
 * Read pixel dimensions from a file header, or null if unrecognized. Supports PNG, JPEG, GIF, and
 * WebP (VP8/VP8L/VP8X). Reads headers only — never decodes.
 */
export function readImageDimensions(bytes: Uint8Array): Dimensions | null {
  // PNG: 8-byte signature, then IHDR (width/height as u32be at offset 16/20).
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { width: u32be(bytes, 16), height: u32be(bytes, 20), format: "png" };
  }
  // GIF: "GIF87a"/"GIF89a", width/height as u16le at offset 6/8.
  if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { width: bytes[6]! | (bytes[7]! << 8), height: bytes[8]! | (bytes[9]! << 8), format: "gif" };
  }
  // WebP: "RIFF"...."WEBP", then a chunk (VP8 / VP8L / VP8X).
  if (bytes.length >= 30 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    const fourcc = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
    if (fourcc === "VP8 ") {
      return { width: (u16be(bytes, 27) & 0x3fff) === 0 ? 0 : ((bytes[27]! | (bytes[28]! << 8)) & 0x3fff),
               height: (bytes[29]! | (bytes[30]! << 8)) & 0x3fff, format: "webp" };
    }
    if (fourcc === "VP8L") {
      const b = u32le(bytes, 21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, format: "webp" };
    }
    if (fourcc === "VP8X") {
      const w = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
      const h = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
      return { width: w, height: h, format: "webp" };
    }
    return null;
  }
  // JPEG: scan segments for a Start-Of-Frame marker carrying height/width.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let o = 2;
    while (o + 9 < bytes.length) {
      if (bytes[o] !== 0xff) {
        o++;
        continue;
      }
      const marker = bytes[o + 1]!;
      // SOF0..SOF15 except DHT(0xc4), DAC(0xcc), and RSTn — the frame markers carry dimensions.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: u16be(bytes, o + 5), width: u16be(bytes, o + 7), format: "jpeg" };
      }
      const len = u16be(bytes, o + 2);
      if (len < 2) return null;
      o += 2 + len;
    }
    return null;
  }
  return null;
}

/** Reject before decoding when width*height exceeds the pixel budget (the bomb guard). */
export function withinPixelBudget(dims: Dimensions, maxPixels: number): boolean {
  return dims.width > 0 && dims.height > 0 && dims.width * dims.height <= maxPixels;
}

/**
 * Strip metadata segments (APPn, including APP1/EXIF with GPS, and COM comments) from a JPEG,
 * keeping the image data intact. Non-JPEG input is returned unchanged (its codec handles metadata).
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  const out: number[] = [0xff, 0xd8];
  let o = 2;
  while (o + 4 <= bytes.length) {
    if (bytes[o] !== 0xff) break;
    const marker = bytes[o + 1]!;
    // Start of scan: copy the rest verbatim (entropy-coded data, no more segment lengths).
    if (marker === 0xda) {
      for (let i = o; i < bytes.length; i++) out.push(bytes[i]!);
      return Uint8Array.from(out);
    }
    const len = u16be(bytes, o + 2);
    if (len < 2) break;
    const isMetadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe; // APPn or COM
    if (!isMetadata) {
      for (let i = o; i < o + 2 + len; i++) out.push(bytes[i]!);
    }
    o += 2 + len;
  }
  return Uint8Array.from(out);
}
