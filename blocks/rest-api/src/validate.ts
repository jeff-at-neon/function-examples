/**
 * Request validation.
 *
 * Pure and separate from the handler so the rules (what a valid todo is, how pagination is bounded)
 * are unit-testable without a database, and so a malformed request fails with a clear 400 instead
 * of a Postgres constraint error leaking out as a 500. ValidationError is the core error that the
 * shared router maps to a 400.
 */

import { ValidationError } from "@neon-blocks/core";

const TITLE_MAX = 500;

/** Fields accepted when creating a todo. */
export interface CreateTodo {
  title: string;
  done: boolean;
}

/** Fields accepted when patching a todo. At least one must be present. */
export interface PatchTodo {
  title?: string;
  done?: boolean;
}

function assertObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function validateTitle(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError('"title" must be a string');
  const title = value.trim();
  if (title.length < 1) throw new ValidationError('"title" must not be empty');
  if (title.length > TITLE_MAX) throw new ValidationError(`"title" must be at most ${TITLE_MAX} characters`);
  return title;
}

export function parseCreate(body: unknown): CreateTodo {
  const o = assertObject(body);
  const title = validateTitle(o["title"]);
  const done = o["done"] === undefined ? false : requireBoolean(o["done"], "done");
  return { title, done };
}

export function parsePatch(body: unknown): PatchTodo {
  const o = assertObject(body);
  const patch: PatchTodo = {};
  if (o["title"] !== undefined) patch.title = validateTitle(o["title"]);
  if (o["done"] !== undefined) patch.done = requireBoolean(o["done"], "done");
  if (patch.title === undefined && patch.done === undefined) {
    throw new ValidationError('Provide at least one of "title" or "done"');
  }
  return patch;
}

function requireBoolean(value: unknown, key: string): boolean {
  if (typeof value !== "boolean") throw new ValidationError(`"${key}" must be a boolean`);
  return value;
}

export interface Pagination {
  limit: number;
  offset: number;
}

/**
 * Parse and clamp pagination.
 *
 * `limit` is clamped to [1, pageSize] rather than rejected, so a caller asking for more simply gets
 * the maximum instead of an error. That keeps the endpoint's response size bounded regardless of
 * input, which is the point on a public route.
 */
export function parsePagination(
  params: URLSearchParams,
  pageSize: number,
): Pagination {
  const limit = clampInt(params.get("limit"), 1, pageSize, pageSize);
  const offset = clampInt(params.get("offset"), 0, Number.MAX_SAFE_INTEGER, 0);
  return { limit, offset };
}

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new ValidationError(`"${raw}" is not an integer`);
  return Math.min(Math.max(n, min), max);
}
