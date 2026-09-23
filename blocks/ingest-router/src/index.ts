/**
 * Block 5 — Ingest Router.
 *
 * One storage trigger per bucket, dispatched in-function by detected file kind. Exists because
 * storage triggers have **no suffix or content-type filter**: without a router you would create
 * twelve triggers on one bucket and each handler would receive all twelve kinds of file.
 *
 * It also solves, once, the three things every storage block would otherwise rediscover:
 * HEAD-verify against forged events, idempotency on (key, etag), and the write-amplification loop.
 *
 * Routes:
 *   POST /route      storage trigger — classify and dispatch
 *   POST /reconcile  cron — re-dispatch what the trigger missed
 *   GET  /health     observability
 */

import {
  assertNoLoop,
  assertTriggerAuthentic,
  checkHealth,
  createLogger,
  getPool,
  json,
  loadConfig,
  parseTriggerRequest,
  problem,
  Router,
  type Logger,
} from "@neon-blocks/core";
import { autoMigrate } from "@neon-blocks/migrate";
import { StorageClient } from "@neon-blocks/storage";
import { dispatchObject, reconcile } from "./dispatch.js";
import { parseRoutes } from "./routes.js";

const log: Logger = createLogger({ block: "ingest-router" });

const SPEC = {
  block: "ingest-router",
  required: ["ROUTER_BUCKET"],
  optional: {
    ROUTER_PREFIX: "uploads/",
    ROUTER_OUTPUT_BUCKET: "",
    ROUTER_OUTPUT_PREFIX: "derived/",
    ROUTER_ROUTES: "{}",
    ROUTER_MAX_BYTES: "524288000",
  },
} as const;

function config() {
  const raw = loadConfig(SPEC);
  const bucket = raw.get("ROUTER_BUCKET");
  const prefix = raw.get("ROUTER_PREFIX");
  const outputPrefix = raw.get("ROUTER_OUTPUT_PREFIX");
  // Empty means "same bucket as input", which is the configuration that needs the loop check.
  const outputBucket = raw.get("ROUTER_OUTPUT_BUCKET") || bucket;

  // Convention §8, enforced at startup rather than documented. If a downstream block writes its
  // derivatives where this router is watching, every output retriggers the router forever — and
  // there is no negative prefix filter to prevent it. This throws rather than warns because the
  // failure mode is a runaway bill discovered on an invoice.
  assertNoLoop({
    inputBucket: bucket,
    inputPrefix: prefix,
    outputBucket,
    outputPrefix,
  });

  return {
    bucket,
    prefix,
    outputBucket,
    outputPrefix,
    routes: parseRoutes(raw.get("ROUTER_ROUTES")),
    maxBytes: raw.int("ROUTER_MAX_BYTES", { min: 1_024 }),
  };
}

const router = new Router();

router.post("/route", async (request) => {
  assertTriggerAuthentic(request, { requireSecret: false });
  const event = await parseTriggerRequest(request);
  if (event.type !== "storage_object_created") {
    return problem(400, "wrong_trigger", `/route expects a storage trigger, got ${event.type}`);
  }

  const cfg = config();
  if (event.bucketName !== cfg.bucket) {
    log.warn("rejecting event for unexpected bucket", {
      received: event.bucketName,
      expected: cfg.bucket,
    });
    return problem(403, "wrong_bucket", `This router only handles "${cfg.bucket}"`);
  }

  const result = await dispatchObject(getPool(), {
    bucket: event.bucketName,
    objectKey: event.objectKey,
    watchedPrefix: cfg.prefix,
    outputPrefix: cfg.outputPrefix,
    routes: cfg.routes,
    maxBytes: cfg.maxBytes,
    storage: StorageClient.fromEnv(),
    logger: log.child({ objectKey: event.objectKey }),
  });

  // Always 200. skipped/unrouted/rejected are correct terminal outcomes; a 5xx would invite
  // retries of work that cannot succeed.
  return json({ ok: true, ...result });
});

router.post("/reconcile", async (request) => {
  assertTriggerAuthentic(request);
  const event = await parseTriggerRequest(request);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", `/reconcile expects a schedule trigger, got ${event.type}`);
  }

  const cfg = config();
  const result = await reconcile(getPool(), {
    bucket: cfg.bucket,
    watchedPrefix: cfg.prefix,
    outputPrefix: cfg.outputPrefix,
    routes: cfg.routes,
    maxBytes: cfg.maxBytes,
    storage: StorageClient.fromEnv(),
    logger: log,
  });

  return json({ ok: true, scheduledAt: event.scheduledAt, ...result });
});

router.get("/health", async () => {
  const cfg = config();
  const report = await checkHealth(getPool(), {
    block: "ingest-router",
    schema: "blocks_ingest_router",
    extra: async () => ({
      // Surfaced so an operator can see the route table without reading env vars off the deploy.
      configured_routes: cfg.routes,
      watched: `${cfg.bucket}/${cfg.prefix}`,
      output: `${cfg.outputBucket}/${cfg.outputPrefix}`,
    }),
    evaluate: (status) => {
      const problems: string[] = [];
      const failed = Number(status["dispatches_failed"] ?? 0);
      const unrouted = Number(status["dispatches_unrouted"] ?? 0);

      if (failed > 0) problems.push(`${failed} dispatch(es) failed`);

      // Degraded, not an error: a kind with no route may be entirely intentional. Surfaced because
      // the common cause is a missing entry in ROUTER_ROUTES, which otherwise looks like nothing
      // happening.
      if (unrouted > 0) {
        problems.push(
          `${unrouted} object(s) matched no route. Check blocks_ingest_router.v_by_kind — the ` +
            `usual cause is a kind missing from ROUTER_ROUTES.`,
        );
      }
      return problems;
    },
  });

  return json(report, { status: report.status === "ok" ? 200 : 503 });
});

export default autoMigrate({
  block: "ingest-router",
  migrationsUrl: new URL("./migrations/", import.meta.url),
  fetch: (request: Request): Promise<Response> => router.handle(request),
});

export { dispatchObject, reconcile } from "./dispatch.js";
export { parseRoutes, jobsForKind, isWatched, isDerivative } from "./routes.js";
