/**
 * Minimal routing and response helpers.
 *
 * Deliberately dependency-free rather than pulling in Hono: a block should bundle to a few
 * KB, and every dependency is one more thing that can break the esbuild single-file path.
 */

export type Handler = (request: Request, ctx: RequestContext) => Promise<Response> | Response;

export interface RequestContext {
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
  /** Correlation id: the Neon trigger invocation id when present, else a generated one. */
  readonly requestId: string;
}

interface Route {
  method: string;
  pattern: string;
  segments: readonly string[];
  handler: Handler;
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...init.headers },
  });
}

export function problem(status: number, title: string, detail?: string): Response {
  return json({ error: title, ...(detail ? { detail } : {}) }, { status });
}

/**
 * Tiny path router supporting `:param` segments.
 *
 * Trigger delivery always POSTs to the configured `function_path`, so most blocks need only
 * two or three routes — a full framework is not justified.
 */
export class Router {
  #routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.#routes.push({
      method: method.toUpperCase(),
      pattern,
      segments: pattern.split("/").filter((s) => s !== ""),
      handler,
    });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add("GET", pattern, handler);
  }

  post(pattern: string, handler: Handler): this {
    return this.add("POST", pattern, handler);
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | undefined {
    const parts = pathname.split("/").filter((s) => s !== "");
    for (const route of this.#routes) {
      if (route.method !== method.toUpperCase()) continue;
      if (route.segments.length !== parts.length) continue;

      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i++) {
        const segment = route.segments[i]!;
        const part = parts[i]!;
        if (segment.startsWith(":")) {
          params[segment.slice(1)] = decodeURIComponent(part);
        } else if (segment !== part) {
          matched = false;
          break;
        }
      }
      if (matched) return { handler: route.handler, params };
    }
    return undefined;
  }

  /** Entry point for a block's default export. */
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const requestId =
      request.headers.get("x-neon-trigger-invocation-id") ?? crypto.randomUUID();

    const found = this.match(request.method, url.pathname);
    if (!found) return problem(404, "not_found", `No route for ${request.method} ${url.pathname}`);

    try {
      return await found.handler(request, { url, params: found.params, requestId });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  }
}

/**
 * Map a thrown error to a response.
 *
 * Client errors (bad payloads, forged triggers) must return 4xx so Neon doesn't retry them
 * forever; genuine faults return 5xx so that retries — whenever Neon documents them — can
 * help. Internal detail is logged, never returned.
 */
export function errorResponse(err: unknown, requestId: string): Response {
  const name = err instanceof Error ? err.name : "Error";
  const message = err instanceof Error ? err.message : String(err);

  const clientErrors: Record<string, number> = {
    TriggerPayloadError: 400,
    ValidationError: 400,
    TriggerAuthError: 403,
    NotFoundError: 404,
    ConfigError: 500,
    LoopHazardError: 500,
  };
  const status = clientErrors[name] ?? 500;

  console.error(
    JSON.stringify({
      level: "error",
      requestId,
      err: name,
      msg: message,
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );

  // Config and loop errors are operator-facing: the message is the whole value, and these
  // endpoints are not reached by end users.
  const safeToEcho = name === "ConfigError" || name === "LoopHazardError" || status < 500;
  return json(
    { error: name, ...(safeToEcho ? { detail: message } : {}), requestId },
    { status },
  );
}

export class ValidationError extends Error {
  override readonly name = "ValidationError";
}

export class NotFoundError extends Error {
  override readonly name = "NotFoundError";
}
