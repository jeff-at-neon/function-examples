/**
 * Block config. Separated from the handler so it can be unit tested without a pool.
 */

import { loadConfig, type LoadedConfig } from "@neon-blocks/core";

export const SPEC = {
  block: "image-derivatives",
  required: ["IMAGES_SOURCE_BUCKET"],
  optional: {
    IMAGES_SOURCE_PREFIX: "uploads/",
    IMAGES_DERIVATIVE_BUCKET: "",
    IMAGES_DERIVATIVE_PREFIX: "derived/",
    IMAGES_MAX_PIXELS: "40000000",
    IMAGES_MAX_BYTES: "26214400",
    IMAGES_ALLOWED_WIDTHS: "64,128,256,512,1024,2048",
    IMAGES_CACHE_CONTROL: "public, max-age=31536000, immutable",
  },
} as const;

export interface ImagesConfig {
  sourceBucket: string;
  sourcePrefix: string;
  derivativeBucket: string;
  derivativePrefix: string;
  maxPixels: number;
  maxBytes: number;
  allowedWidths: number[];
  cacheControl: string;
  raw: LoadedConfig;
}

export function loadImagesConfig(env?: NodeJS.ProcessEnv): ImagesConfig {
  const raw = loadConfig(SPEC, env);
  const sourceBucket = raw.get("IMAGES_SOURCE_BUCKET");
  const allowedWidths = raw
    .get("IMAGES_ALLOWED_WIDTHS")
    .split(",")
    .map((w) => Number(w.trim()))
    .filter((w) => Number.isInteger(w) && w > 0);
  return {
    sourceBucket,
    sourcePrefix: raw.get("IMAGES_SOURCE_PREFIX"),
    derivativeBucket: raw.get("IMAGES_DERIVATIVE_BUCKET") || sourceBucket,
    derivativePrefix: raw.get("IMAGES_DERIVATIVE_PREFIX"),
    maxPixels: raw.int("IMAGES_MAX_PIXELS", { min: 1 }),
    maxBytes: raw.int("IMAGES_MAX_BYTES", { min: 1024 }),
    allowedWidths,
    cacheControl: raw.get("IMAGES_CACHE_CONTROL"),
    raw,
  };
}
