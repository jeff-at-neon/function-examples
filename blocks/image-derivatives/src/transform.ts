/**
 * Transform parameters and derivative naming. Pure and unit tested. The width allowlist is a
 * cost-control decision, not a style one: arbitrary widths let a caller generate unlimited
 * derivatives of one image on a public endpoint and bill you for every one.
 */

import { ValidationError } from "@neon-blocks/core";

export interface Transform {
  width: number;
  height: number | null;
  format: string;
  fit: string;
}

export function parseTransform(params: URLSearchParams, allowedWidths: readonly number[]): Transform {
  const widthRaw = params.get("w");
  if (!widthRaw) throw new ValidationError("?w= (width) is required");

  const width = Number(widthRaw);
  if (!allowedWidths.includes(width)) {
    throw new ValidationError(
      `Width ${widthRaw} is not permitted. Allowed: ${allowedWidths.join(", ")}. This is an ` +
        `allowlist because arbitrary widths let a caller generate unlimited derivatives at your expense.`,
    );
  }

  const heightRaw = params.get("h");
  const height = heightRaw ? Number(heightRaw) : null;
  if (height !== null && (!Number.isInteger(height) || height < 1 || height > 8192)) {
    throw new ValidationError("?h= must be an integer between 1 and 8192");
  }

  const format = params.get("f") ?? "webp";
  if (!["webp", "jpeg", "png", "avif"].includes(format)) {
    throw new ValidationError("?f= must be one of webp, jpeg, png, avif");
  }

  const fit = params.get("fit") ?? "cover";
  if (!["cover", "contain", "fill", "inside"].includes(fit)) {
    throw new ValidationError("?fit= must be one of cover, contain, fill, inside");
  }

  return { width, height, format, fit };
}

/** Derivative key, derived from the source basename, the etag, and every transform parameter. */
export function derivativeKeyFor(prefix: string, sourceKey: string, etag: string, t: Transform): string {
  const base = sourceKey.replace(/\.[^./]+$/, "").replace(/^.*\//, "");
  const dims = t.height === null ? `w${t.width}` : `w${t.width}h${t.height}`;
  // The etag is in the key, so an overwritten source cannot serve a stale derivative: the new etag
  // simply misses and regenerates.
  return `${prefix}${base}-${dims}-${t.fit}-${etag.slice(0, 8)}.${t.format}`;
}
