import { describe, expect, it } from "vitest";
import { readImageDimensions, stripJpegMetadata, withinPixelBudget } from "../src/image.js";

// Minimal PNG: 8-byte signature + IHDR with width/height.
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  return b;
}

// Minimal GIF header with little-endian width/height at offset 6/8.
function gif(width: number, height: number): Uint8Array {
  const b = new Uint8Array(10);
  b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // GIF89a
  b[6] = width & 0xff;
  b[7] = (width >> 8) & 0xff;
  b[8] = height & 0xff;
  b[9] = (height >> 8) & 0xff;
  return b;
}

describe("readImageDimensions", () => {
  it("reads PNG dimensions from IHDR", () => {
    expect(readImageDimensions(png(800, 600))).toEqual({ width: 800, height: 600, format: "png" });
  });
  it("reads GIF dimensions (little-endian)", () => {
    expect(readImageDimensions(gif(300, 200))).toEqual({ width: 300, height: 200, format: "gif" });
  });
  it("returns null for an unrecognized header", () => {
    expect(readImageDimensions(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});

describe("withinPixelBudget (decompression-bomb guard)", () => {
  it("passes an image within budget", () => {
    expect(withinPixelBudget({ width: 1000, height: 1000, format: "png" }, 40_000_000)).toBe(true);
  });
  // A tiny file can declare enormous dimensions — the guard reads the header, not the byte size.
  it("rejects a declared-huge image", () => {
    expect(withinPixelBudget({ width: 30_000, height: 30_000, format: "png" }, 40_000_000)).toBe(false);
  });
  it("rejects zero/degenerate dimensions", () => {
    expect(withinPixelBudget({ width: 0, height: 100, format: "png" }, 40_000_000)).toBe(false);
  });
});

describe("stripJpegMetadata", () => {
  it("removes an APP1/EXIF segment, keeping SOI and image data", () => {
    // SOI + APP1(len 4, 2 payload bytes) + SOS + data + EOI
    const input = Uint8Array.from([
      0xff, 0xd8, // SOI
      0xff, 0xe1, 0x00, 0x04, 0x45, 0x78, // APP1 len=4, "Ex"
      0xff, 0xda, 0x00, 0x02, // SOS len=2
      0x12, 0x34, // scan data
      0xff, 0xd9, // EOI
    ]);
    const out = stripJpegMetadata(input);
    // APP1 (ff e1 ...) is gone; SOI and the SOS-onward bytes remain.
    expect(Array.from(out.slice(0, 2))).toEqual([0xff, 0xd8]);
    expect(Array.from(out)).not.toContain(0xe1);
    expect(Array.from(out.slice(2, 4))).toEqual([0xff, 0xda]); // SOS immediately follows SOI now
  });

  it("returns non-JPEG input unchanged", () => {
    const p = png(10, 10);
    expect(stripJpegMetadata(p)).toBe(p);
  });
});
