/**
 * Route table parsing and matching.
 *
 * Pure. The router's whole job is turning "an object appeared" into "these jobs should run", and
 * that decision must be inspectable without a database or a bucket.
 */

import type { ObjectKind } from "@neon-blocks/storage";
import { ValidationError } from "@neon-blocks/core";

/** kind → job types to enqueue. */
export type RouteTable = Readonly<Record<string, readonly string[]>>;

const KNOWN_KINDS: readonly ObjectKind[] = [
  "image",
  "pdf",
  "document",
  "spreadsheet",
  "text",
  "audio",
  "video",
  "archive",
  "data",
  "unknown",
];

/**
 * Parse ROUTER_ROUTES.
 *
 * Validates kind names against the known set, because a typo like `"images"` silently routes
 * nothing — the worst class of configuration bug, since the router keeps reporting success.
 */
export function parseRoutes(raw: string): RouteTable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ValidationError(
      `ROUTER_ROUTES is not valid JSON: ${err instanceof Error ? err.message : String(err)}. ` +
        `Expected an object like {"image":["vision.tag"],"pdf":["rag.ingest"]}.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError(`ROUTER_ROUTES must be a JSON object mapping kind to job types.`);
  }

  const table: Record<string, readonly string[]> = {};

  for (const [kind, value] of Object.entries(parsed)) {
    if (!KNOWN_KINDS.includes(kind as ObjectKind)) {
      throw new ValidationError(
        `ROUTER_ROUTES has unknown kind "${kind}". Valid kinds: ${KNOWN_KINDS.join(", ")}. ` +
          `A typo here silently routes nothing while the router keeps reporting success.`,
      );
    }
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v === "")) {
      throw new ValidationError(
        `ROUTER_ROUTES["${kind}"] must be an array of job type strings, e.g. ["rag.ingest"].`,
      );
    }
    for (const jobType of value as string[]) {
      if (!/^[a-z][a-z0-9_.]*$/.test(jobType)) {
        // Matches the queue's own constraint, so an invalid type fails here rather than at enqueue
        // time where the object has already been consumed.
        throw new ValidationError(
          `ROUTER_ROUTES["${kind}"] contains invalid job type "${jobType}". Use lowercase with ` +
            `dots or underscores, e.g. "rag.ingest".`,
        );
      }
    }
    table[kind] = value as string[];
  }

  return table;
}

/** Job types for a detected kind. Empty means deliberately unrouted, not an error. */
export function jobsForKind(routes: RouteTable, kind: ObjectKind): readonly string[] {
  return routes[kind] ?? [];
}

/**
 * Whether a key should be processed at all.
 *
 * Belt and braces against the trigger's prefix filter: delivery is unauthenticated, so a forged
 * POST can name any key regardless of what the trigger was configured to watch.
 */
export function isWatched(key: string, watchedPrefix: string): boolean {
  const prefix =
    watchedPrefix === "" || watchedPrefix.endsWith("/") ? watchedPrefix : `${watchedPrefix}/`;
  return key.startsWith(prefix);
}

/**
 * Whether a key is a derivative this router produced.
 *
 * The write-amplification guard. There is no negative prefix filter on storage triggers, so if a
 * downstream block writes into the watched bucket, its output arrives back here. Recognising and
 * ignoring it is what stops an infinite loop that bills real money.
 */
export function isDerivative(key: string, outputPrefix: string): boolean {
  if (outputPrefix === "") return false;
  const prefix = outputPrefix.endsWith("/") ? outputPrefix : `${outputPrefix}/`;
  // Checked anywhere in the key, not just at the start: a derivative written as
  // `uploads/tenant/derived/thumb.jpg` is still a derivative even though the key begins with the
  // watched prefix.
  return key.startsWith(prefix) || key.includes(`/${prefix}`);
}
