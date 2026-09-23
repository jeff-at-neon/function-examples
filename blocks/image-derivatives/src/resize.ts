/**
 * Resize orchestration: GET the source, enforce the pixel-budget bomb guard BEFORE any decode,
 * resize through a Codec, strip EXIF/GPS, PUT the derivative, and record the row. The guard and the
 * metadata strip are the pure, tested safety logic (image.ts); the pixel resize is the one part
 * that needs an image codec.
 *
 * The codec is a deploy-time dependency, exactly as the AI blocks depend on the AI Gateway: the
 * esbuild bundle cannot ship a native .node binary, so a WASM libvips (or equivalent) adapter is
 * supplied via setCodec(). With none configured, resize fails with a specific, honest error rather
 * than a fake success — the guards and caching still run.
 */

import type { Queryable } from "@neon-blocks/core";
import type { StorageClient } from "@neon-blocks/storage";
import { readImageDimensions, stripJpegMetadata, withinPixelBudget } from "./image.js";
import type { Transform } from "./transform.js";

export interface Codec {
  /** Resize/re-encode the input image to the transform's dimensions and format. */
  resize(input: Uint8Array, t: Transform): Promise<Uint8Array>;
}

let codec: Codec | null = null;
/** Install the image codec adapter (e.g. a WASM libvips wrapper) at startup. */
export function setCodec(c: Codec): void {
  codec = c;
}

export class CodecNotConfiguredError extends Error {
  override readonly name = "CodecNotConfiguredError";
  constructor() {
    super(
      "no image codec configured. The esbuild bundle cannot load a native resizer, so a WASM " +
        "codec adapter must be installed via setCodec() (see docs/RUNTIME.md).",
    );
  }
}

export interface DerivativeResult {
  status: "ready" | "rejected";
  reason?: string;
  bytes?: number;
}

export async function generateDerivative(
  deps: { db: Queryable; storage: StorageClient },
  opts: {
    sourceBucket: string;
    sourceKey: string;
    sourceEtag: string;
    derivativeBucket: string;
    derivativeKey: string;
    transform: Transform;
    maxBytes: number;
    maxPixels: number;
  },
): Promise<DerivativeResult> {
  const { db, storage } = deps;

  const { rows: created } = await db.query<{ id: string }>(
    `INSERT INTO blocks_image_derivatives.derivatives
       (source_bucket, source_key, source_etag, width, height, format, fit,
        derivative_bucket, derivative_key, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'generating')
     ON CONFLICT (source_bucket, source_key, source_etag, width, height, format, fit)
       DO UPDATE SET status = 'generating'
     RETURNING id`,
    [
      opts.sourceBucket, opts.sourceKey, opts.sourceEtag, opts.transform.width, opts.transform.height,
      opts.transform.format, opts.transform.fit, opts.derivativeBucket, opts.derivativeKey,
    ],
  );
  const id = created[0]!.id;

  const { body } = await storage.getObject(opts.sourceBucket, opts.sourceKey, { maxBytes: opts.maxBytes });

  // Bomb guard: read declared dimensions from the header and reject before decoding.
  const dims = readImageDimensions(body);
  if (!dims) {
    await mark(db, id, "rejected", "could not read image dimensions");
    return { status: "rejected", reason: "unreadable image header" };
  }
  if (!withinPixelBudget(dims, opts.maxPixels)) {
    await mark(db, id, "rejected", `image is ${dims.width}x${dims.height}, over the pixel budget`);
    return { status: "rejected", reason: "over pixel budget" };
  }

  if (!codec) throw new CodecNotConfiguredError();
  let output = await codec.resize(body, opts.transform);
  if (opts.transform.format === "jpeg") output = stripJpegMetadata(output);

  await storage.putObject(opts.derivativeBucket, opts.derivativeKey, output, {
    contentType: `image/${opts.transform.format}`,
  });
  await db.query(
    `UPDATE blocks_image_derivatives.derivatives
     SET status = 'ready', derivative_bytes = $2, generated_at = now() WHERE id = $1`,
    [id, output.byteLength],
  );
  return { status: "ready", bytes: output.byteLength };
}

async function mark(db: Queryable, id: string, status: string, error: string): Promise<void> {
  await db.query(`UPDATE blocks_image_derivatives.derivatives SET status = $2, error = $3 WHERE id = $1`, [
    id,
    status,
    error,
  ]);
}
