import { INJECTED_DB, INJECTED_STORAGE, TRIGGER_SECRET } from "./lib/generate.mjs";

/** @type {import("./lib/generate.mjs").BlockSpec[]} */
export const SPECS = [
  {
    slug: "image-derivatives",
    rank: 23,
    name: "Image Derivatives",
    summary:
      "Thumbnails and transforms with EXIF stripping, generated on read and cached, not eagerly on upload.",
    billing: "meter",
    capabilities: ["postgres", "object_storage"],
    dependsOn: [],
    why:
      "Image resizing is well served by dedicated image CDNs, and running it next to Postgres buys\n" +
      "nothing for the pixel work itself. What it does buy is the registry join -- \"every image this\n" +
      "tenant owns, and whether its thumbnail exists yet\" -- which is not a question object storage\n" +
      "can answer on its own.\n" +
      "\n" +
      "Built late because of packaging, not cost. The compute is affordable: active Capacity-Hours are\n" +
      "4x waiting rather than 40x, which works out around $16-26 per million images. The real obstacle\n" +
      "is that the default esbuild bundle cannot load native .node binaries, so sharp breaks the\n" +
      "one-command install.",
    notes: [
      "**Transform-on-read, not eager generation.** Eager generation means guessing sizes up front, regenerating everything when the design changes, and paying to store derivatives nobody requests. On-demand with a cache check inverts all three.",
      "**WASM libvips by default, native `sharp` as an opt-in.** WASM is 2–4× slower but bundles cleanly with the default esbuild path, which keeps `neon-blocks add` a single command. Native needs `bundler: \"none\"` plus a platform-matched `node_modules`, and unbundled deploys cannot ship TypeScript.",
      "**Derivatives go to a separate bucket or a provably disjoint prefix, enforced at startup.** Writing output into the watched bucket retriggers the pipeline forever, and there is no negative prefix filter to prevent it. `assertNoLoop` throws rather than warns because the failure mode is a runaway bill.",
      "**EXIF and GPS are stripped unconditionally.** A phone photo carries the coordinates of where it was taken; serving that alongside a user's avatar is a privacy leak nobody remembers to handle, so it is not configurable.",
      "**Pixel count is capped, not just byte size.** A 40 KB PNG can decode to 30,000×30,000 pixels and exhaust memory instantly. Byte limits do not catch decompression bombs; dimension limits do.",
    ],
    limits: [
      "**The resize call is a TODO seam.** The cache lookup, loop guard, dimension validation, and metadata recording are real; the pixel work is not wired, and the library choice determines the packaging story.",
      "**Without a CDN in front, every image request is a billed invocation.** Transform-on-read is only economical with edge caching, where the 99% cache-hit path never reaches compute. This is the single biggest platform ask for making this block genuinely good.",
      "**Functions run at a fixed size**, so there is no scaling up for large TIFFs. Big sources fail rather than run slowly, which is why the pixel cap exists.",
      "**No `storage_object_deleted` event exists**, so a deleted source leaves its derivatives orphaned. The reconciler detects that by absence; until it runs you are paying to store garbage.",
      "**AVIF and JPEG XL support depends on the chosen library**, and the WASM build may lack encoders the native build has.",
    ],
    env: [
      INJECTED_DB,
      ...INJECTED_STORAGE,
      {
        name: "IMAGES_SOURCE_BUCKET",
        description: "Bucket holding original images.",
        required: true,
        example: "uploads",
      },
      {
        name: "IMAGES_SOURCE_PREFIX",
        description: "Prefix under which originals live.",
        required: false,
        default: "uploads/",
      },
      {
        name: "IMAGES_DERIVATIVE_BUCKET",
        description:
          "Where derivatives are written. A separate bucket is the safest shape; empty reuses the source bucket, which then requires a disjoint prefix.",
        required: false,
        default: "",
      },
      {
        name: "IMAGES_DERIVATIVE_PREFIX",
        description:
          "Prefix for derivatives. Must be provably disjoint from IMAGES_SOURCE_PREFIX when sharing a bucket, or every output retriggers the pipeline.",
        required: false,
        default: "derived/",
      },
      {
        name: "IMAGES_MAX_PIXELS",
        description:
          "Maximum source pixel count. The decompression-bomb guard: a 40KB PNG can decode to 30000x30000, which a byte limit does not catch.",
        required: false,
        default: "40000000",
      },
      {
        name: "IMAGES_MAX_BYTES",
        description: "Maximum source file size.",
        required: false,
        default: "26214400",
      },
      {
        name: "IMAGES_ALLOWED_WIDTHS",
        description:
          "Comma-separated permitted widths. An allowlist, not a range: unbounded widths let a caller generate unlimited distinct derivatives and bill you for each.",
        required: false,
        default: "64,128,256,512,1024,2048",
      },
      {
        name: "IMAGES_CACHE_CONTROL",
        description:
          "Cache-Control on served derivatives. Long, because content is immutable for a given key and etag.",
        required: false,
        default: "public, max-age=31536000, immutable",
      },
      TRIGGER_SECRET,
    ],
    triggers: [
      {
        type: "schedule",
        cron: "19 5 * * *",
        functionPath: "/reconcile",
        description:
          "Required by §5. Detects derivatives whose source is gone -- there are no storage delete events, so orphans are otherwise permanent and you keep paying to store them.",
      },
    ],
    tables: `
-- One row per generated derivative. The point of recording them in SQL is the registry join:
-- "every image belonging to this tenant, and whether its thumbnail exists yet" is not a question
-- Object Storage can answer.
CREATE TABLE IF NOT EXISTS blocks_image_derivatives.derivatives (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  source_bucket   text        NOT NULL,
  source_key      text        NOT NULL,
  -- The other half of the idempotency contract: overwriting a source produces a new etag, so its
  -- derivatives must be regenerated rather than served stale.
  source_etag     text        NOT NULL,

  -- Transform parameters, part of the identity so an identical request hits the cache.
  width           integer     NOT NULL,
  height          integer,
  format          text        NOT NULL DEFAULT 'webp',
  fit             text        NOT NULL DEFAULT 'cover',

  derivative_bucket text      NOT NULL,
  derivative_key  text        NOT NULL,
  derivative_bytes bigint,

  status          text        NOT NULL DEFAULT 'pending',
  error           text,

  -- Set by the reconciler when the source no longer exists. Without storage delete events these
  -- rows would be permanent, and so would the storage cost of the files they point at.
  orphaned_at     timestamptz,

  hit_count       integer     NOT NULL DEFAULT 0,
  last_served_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  generated_at    timestamptz,

  CONSTRAINT derivatives_status_valid
    CHECK (status IN ('pending', 'generating', 'ready', 'failed', 'rejected', 'orphaned')),
  CONSTRAINT derivatives_format_valid CHECK (format IN ('webp', 'jpeg', 'png', 'avif')),
  CONSTRAINT derivatives_fit_valid CHECK (fit IN ('cover', 'contain', 'fill', 'inside')),
  CONSTRAINT derivatives_dimensions_sane CHECK (width > 0 AND (height IS NULL OR height > 0)),
  -- Identity includes every transform parameter AND the source etag, so a cache hit is an exact
  -- match on both the request and the underlying bytes.
  CONSTRAINT derivatives_identity
    UNIQUE (source_bucket, source_key, source_etag, width, height, format, fit)
);

CREATE INDEX IF NOT EXISTS derivatives_source_idx
  ON blocks_image_derivatives.derivatives (source_bucket, source_key);
CREATE INDEX IF NOT EXISTS derivatives_status_idx
  ON blocks_image_derivatives.derivatives (status, created_at);
-- Serves the orphan sweep without scanning healthy rows.
CREATE INDEX IF NOT EXISTS derivatives_orphan_idx
  ON blocks_image_derivatives.derivatives (orphaned_at) WHERE orphaned_at IS NOT NULL;
-- Least-recently-served first, for evicting derivatives nobody requests.
CREATE INDEX IF NOT EXISTS derivatives_lru_idx
  ON blocks_image_derivatives.derivatives (last_served_at NULLS FIRST)
  WHERE status = 'ready';`,
    statusView: `
  count(*)                                              AS derivatives_total,
  count(*) FILTER (WHERE status = 'ready')               AS derivatives_ready,
  count(*) FILTER (WHERE status = 'failed')              AS derivatives_failed,
  -- Rejected for exceeding a pixel or dimension guard. Expected, not alarming: it is the
  -- decompression-bomb defence working.
  count(*) FILTER (WHERE status = 'rejected')            AS derivatives_rejected,
  count(*) FILTER (WHERE status IN ('pending', 'generating')
                     AND created_at < now() - interval '1 hour') AS derivatives_stuck,

  -- Derivatives whose source is gone. You are paying to store these.
  count(*) FILTER (WHERE orphaned_at IS NOT NULL)        AS derivatives_orphaned,
  COALESCE(sum(derivative_bytes) FILTER (WHERE orphaned_at IS NOT NULL), 0) AS orphaned_bytes,

  COALESCE(sum(derivative_bytes) FILTER (WHERE status = 'ready'), 0) AS bytes_stored,
  COALESCE(sum(hit_count), 0)                           AS serves_total,
  -- Generated but never served: a size nobody requests, which is what eager generation produces.
  count(*) FILTER (WHERE status = 'ready' AND hit_count = 0
                     AND created_at < now() - interval '7 days') AS derivatives_never_served
FROM blocks_image_derivatives.derivatives`,
    dropOrder: ["TABLE blocks_image_derivatives.derivatives"],
    routes: [
      { method: "GET", path: "/i/:key", purpose: "Serve a derivative, generating on a cache miss." },
      { method: "POST", path: "/reconcile", purpose: "Cron. Mark derivatives whose source is gone." },
      { method: "GET", path: "/derivatives", purpose: "Derivatives for a source key." },
    ],
    imports: [
      'import { StorageClient, detectKind, ObjectNotFoundError } from "@neon-blocks/storage";',
    ],
    handlerBody: `
/**
 * Validate transform parameters against the allowlist.
 *
 * An allowlist rather than a range, deliberately. Arbitrary widths let a caller request 10,000
 * distinct sizes of one image and bill you for every one -- on a public endpoint that is a
 * cost-amplification attack, not a hypothetical.
 */
export function parseTransform(
  params: URLSearchParams,
  allowedWidths: readonly number[],
): { width: number; height: number | null; format: string; fit: string } {
  const widthRaw = params.get("w");
  if (!widthRaw) throw new ValidationError("?w= (width) is required");

  const width = Number(widthRaw);
  if (!allowedWidths.includes(width)) {
    throw new ValidationError(
      \`Width \${widthRaw} is not permitted. Allowed: \${allowedWidths.join(", ")}. This is an \` +
        \`allowlist because arbitrary widths let a caller generate unlimited derivatives at your expense.\`,
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

/** Derivative key, derived from the source, the etag, and every transform parameter. */
export function derivativeKeyFor(
  prefix: string,
  sourceKey: string,
  etag: string,
  t: { width: number; height: number | null; format: string; fit: string },
): string {
  const base = sourceKey.replace(/\\.[^./]+$/, "").replace(/^.*\\//, "");
  const dims = t.height === null ? \`w\${t.width}\` : \`w\${t.width}h\${t.height}\`;
  // The etag is in the key, so an overwritten source cannot serve a stale derivative: the new etag
  // simply misses and regenerates.
  return \`\${prefix}\${base}-\${dims}-\${t.fit}-\${etag.slice(0, 8)}.\${t.format}\`;
}

router.get("/i/:key", async (_request, ctx) => {
  const cfg = config();
  const sourceKey = ctx.params["key"]!;

  const allowedWidths = cfg
    .get("IMAGES_ALLOWED_WIDTHS")
    .split(",")
    .map((w) => Number(w.trim()))
    .filter((w) => Number.isInteger(w) && w > 0);

  const transform = parseTransform(ctx.url.searchParams, allowedWidths);

  const sourceBucket = cfg.get("IMAGES_SOURCE_BUCKET");
  const derivativeBucket = cfg.get("IMAGES_DERIVATIVE_BUCKET") || sourceBucket;
  const derivativePrefix = cfg.get("IMAGES_DERIVATIVE_PREFIX");

  // §8, checked here as well as at startup. Writing derivatives into the watched bucket retriggers
  // the pipeline forever and there is no negative prefix filter to stop it.
  assertNoLoop({
    inputBucket: sourceBucket,
    inputPrefix: cfg.get("IMAGES_SOURCE_PREFIX"),
    outputBucket: derivativeBucket,
    outputPrefix: derivativePrefix,
  });

  const storage = StorageClient.fromEnv();

  if (detectKind({ key: sourceKey }) !== "image") {
    return problem(400, "not_an_image", \`\${sourceKey} does not look like an image\`);
  }

  // HEAD the source for its etag, which is part of the cache key.
  let sourceMeta;
  try {
    sourceMeta = await storage.headVerified(sourceBucket, sourceKey);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) throw new NotFoundError("No such source image");
    throw err;
  }

  const maxBytes = cfg.int("IMAGES_MAX_BYTES", { min: 1024 });
  if (sourceMeta.size > maxBytes) {
    return problem(
      413,
      "source_too_large",
      \`Source is \${sourceMeta.size} bytes, over the \${maxBytes} limit. Functions run at a fixed \` +
        \`size, so there is no scaling up for large images.\`,
    );
  }

  const derivativeKey = derivativeKeyFor(derivativePrefix, sourceKey, sourceMeta.etag, transform);
  const pool = getPool();

  // Cache check first -- the whole point of transform-on-read. A hit costs one indexed lookup and a
  // redirect, with no pixel work at all.
  const { rows: cached } = await pool.query<{ id: string; derivative_key: string }>(
    \`UPDATE blocks_image_derivatives.derivatives
     SET hit_count = hit_count + 1, last_served_at = now()
     WHERE source_bucket = $1 AND source_key = $2 AND source_etag = $3
       AND width = $4 AND height IS NOT DISTINCT FROM $5 AND format = $6 AND fit = $7
       AND status = 'ready'
     RETURNING id, derivative_key\`,
    [sourceBucket, sourceKey, sourceMeta.etag, transform.width, transform.height,
     transform.format, transform.fit],
  );

  if (cached[0]) {
    // Redirect to a presigned URL rather than streaming bytes through the function: streaming would
    // bill Capacity-Hours to do nothing but copy, on every request.
    return new Response(null, {
      status: 302,
      headers: {
        location: storage.presignGet(derivativeBucket, cached[0].derivative_key, {
          expiresInSeconds: 3600,
        }),
        "cache-control": cfg.get("IMAGES_CACHE_CONTROL"),
      },
    });
  }

  void derivativeKey;

  // TODO(image-derivatives): the resize.
  //   1. GET the source, bounded by IMAGES_MAX_BYTES
  //   2. read dimensions and reject if width*height > IMAGES_MAX_PIXELS. This must happen BEFORE
  //      decoding: a 40KB PNG can decode to 30000x30000 and exhaust memory instantly, which a byte
  //      limit does not catch.
  //   3. resize with WASM libvips (default) or native sharp (opt-in, needs bundler: "none" plus a
  //      platform-matched node_modules -- and unbundled deploys cannot ship TypeScript)
  //   4. strip EXIF and GPS unconditionally. A phone photo carries the coordinates where it was
  //      taken, and serving that with an avatar is a privacy leak nobody remembers to handle.
  //   5. PUT to derivativeBucket/derivativeKey and record the row as ready
  //
  //   Without a CDN in front of this endpoint every request is a billed invocation.
  //   Transform-on-read is only economical with edge caching.
  return problem(
    501,
    "not_implemented",
    "Resizing is not yet wired. See the TODO in src/index.ts. The cache lookup, loop guard, and " +
      "dimension validation above are real; the WASM-vs-native choice determines packaging, since " +
      "the default esbuild bundle cannot load native .node binaries.",
  );
});

router.post("/reconcile", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", \`/reconcile expects a schedule trigger, got \${event.type}\`);
  }

  const cfg = config();
  const storage = StorageClient.fromEnv();
  const pool = getPool();
  const sourceBucket = cfg.get("IMAGES_SOURCE_BUCKET");

  // No storage delete events exist, so orphans are detected by absence. Without this a deleted
  // source leaves its derivatives on disk forever and you keep paying for them.
  const listing = await storage.listObjects(sourceBucket, {
    prefix: cfg.get("IMAGES_SOURCE_PREFIX"),
    maxKeys: 1000,
  });

  if (listing.nextContinuationToken) {
    // From a partial listing every unlisted source looks deleted, which would orphan live
    // derivatives. §10: reported rather than silently narrowed.
    log.capped("source listing truncated; orphan detection skipped", {
      bucket: sourceBucket,
      scanned: listing.objects.length,
    });
    return json({
      ok: true,
      scheduledAt: event.scheduledAt,
      sourcesScanned: listing.objects.length,
      orphansMarked: 0,
      listingTruncated: true,
      note: "Orphan detection skipped: a partial listing would wrongly orphan live derivatives.",
    });
  }

  const { rowCount: marked } = await pool.query(
    \`UPDATE blocks_image_derivatives.derivatives
     SET status = 'orphaned', orphaned_at = now()
     WHERE source_bucket = $1
       AND orphaned_at IS NULL
       AND NOT (source_key = ANY($2::text[]))\`,
    [sourceBucket, listing.objects.map((o) => o.key)],
  );

  // TODO(image-derivatives): delete orphaned objects from storage, then their rows. Marking works;
  // the storage delete does not, so orphaned bytes are still being paid for -- v_status reports
  // orphaned_bytes so that cost is visible rather than silent.
  return json({
    ok: true,
    scheduledAt: event.scheduledAt,
    sourcesScanned: listing.objects.length,
    orphansMarked: marked ?? 0,
    note: marked ? "Orphans marked; storage deletion is not yet wired." : undefined,
  });
});

router.get("/derivatives", async (_request, ctx) => {
  const sourceKey = ctx.url.searchParams.get("key");
  if (!sourceKey) throw new ValidationError("?key= is required");

  const { rows } = await getPool().query(
    \`SELECT width, height, format, fit, status, derivative_bytes, hit_count,
            last_served_at, generated_at
     FROM blocks_image_derivatives.derivatives
     WHERE source_key = $1
     ORDER BY width, format\`,
    [sourceKey],
  );

  return json({ sourceKey, count: rows.length, derivatives: rows });
});`,
    healthEval: `
      const stuck = Number(status["derivatives_stuck"] ?? 0);
      const failed = Number(status["derivatives_failed"] ?? 0);
      const orphaned = Number(status["derivatives_orphaned"] ?? 0);
      const orphanedBytes = Number(status["orphaned_bytes"] ?? 0);
      const neverServed = Number(status["derivatives_never_served"] ?? 0);

      if (stuck > 0) problems.push(\`\${stuck} derivative(s) stuck generating for over an hour\`);
      if (failed > 0) problems.push(\`\${failed} derivative(s) failed to generate\`);
      if (orphaned > 0) {
        // Real money spent on files nothing references.
        problems.push(
          \`\${orphaned} orphaned derivative(s) holding \${Math.round(orphanedBytes / 1_048_576)} MiB; \` +
            \`their sources are gone and you are still paying to store them\`,
        );
      }
      if (neverServed > 100) {
        problems.push(
          \`\${neverServed} derivative(s) generated over a week ago have never been served, which \` +
            \`suggests sizes are being produced that nobody requests\`,
        );
      }`,
  },

  {
    slug: "analytics",
    rank: 24,
    name: "Event Analytics",
    summary:
      "Event ingest, sessionization, and a funnel, retention, and cohort query pack over your own Postgres.",
    billing: "free",
    capabilities: ["postgres"],
    dependsOn: ["queue"],
    why:
      "Product analytics where events live next to the rest of your data, so a funnel can join against\n" +
      "your actual customer table rather than whatever you remembered to send to a third party. The\n" +
      "hard parts are sessionization -- a gap-based window function, not a timestamp bucket -- and\n" +
      "keeping the queries fast enough to run interactively on real volume.",
    notes: [
      "**Sessionization is a 30-minute inactivity gap computed with a window function.** Not a fixed clock window: a user active 10:55–11:05 is one session, and calendar-hour bucketing would split them in two and halve your session count.",
      "**Events are append-only and never updated.** A table that permits updates cannot be trusted retrospectively, and every rollup derived from it becomes unreproducible.",
      "**Ingest is bulk-friendly and idempotent.** Clients batch and retry, so a dedupe key is mandatory — without one a retried batch silently doubles every metric it contains.",
      "**Funnels are ordered-step queries, not a count of users who did all the steps.** Someone who checked out before adding to cart has not converted through the funnel, and ignoring order inflates conversion rates.",
      "**Retention is cohort-by-period anchored to first-seen.** A single retention number hides whether the product is improving; cohorts are what make a change visible.",
    ],
    limits: [
      "**The funnel, retention, and cohort queries are TODO seams.** Schema, sessionization SQL, and ingest are real; the analysis pack is specified in comments but not written.",
      "**No partitioning or column store.** On tens of millions of events these queries get slow. Monthly partitioning of `events` is the first thing to add, and it is a migration rather than a tweak.",
      "**Property filtering is JSONB containment.** Flexible, but a GIN index on `properties` grows large, and hot properties are better promoted to real columns.",
      "**No identity stitching.** Anonymous events before signup are not merged into the user afterwards, so first-touch attribution is wrong for every user. A genuine gap, not a simplification.",
      "**Timezones are UTC throughout**, so daily rollups will not match a customer expecting their local business day.",
    ],
    env: [
      INJECTED_DB,
      {
        name: "ANALYTICS_SESSION_GAP_MINUTES",
        description:
          "Inactivity gap that ends a session. 30 is conventional; changing it changes every historical session count.",
        required: false,
        default: "30",
      },
      {
        name: "ANALYTICS_MAX_BATCH",
        description: "Events accepted per ingest request.",
        required: false,
        default: "1000",
      },
      {
        name: "ANALYTICS_RETENTION_DAYS",
        description:
          "Days raw events are kept. Rollups outlive them, so long-range trends survive the purge.",
        required: false,
        default: "400",
      },
      TRIGGER_SECRET,
    ],
    triggers: [
      {
        type: "schedule",
        cron: "13 1 * * *",
        functionPath: "/rollup",
        description:
          "Sessionize new events and refresh daily aggregates. Off-peak, because it scans a day of raw events.",
      },
    ],
    tables: `
-- Append-only. A table that permits updates cannot be trusted retrospectively, and every rollup
-- derived from it becomes unreproducible.
CREATE TABLE IF NOT EXISTS blocks_analytics.events (
  id            bigserial   PRIMARY KEY,

  -- anonymous_id before signup, user_ref after. Both recorded, but NOT stitched -- see limitations.
  anonymous_id  text,
  user_ref      text,

  event_name    text        NOT NULL,
  properties    jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- Client-asserted time, kept separate from received_at. Clock skew and offline buffering can put
  -- them hours apart, and conflating them makes event ordering wrong.
  occurred_at   timestamptz NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),

  -- Assigned by the rollup pass, not at ingest: sessionization needs surrounding events to know
  -- where a gap falls.
  session_id    uuid,

  -- Client-supplied dedupe key. Clients batch and retry, so without this a retried batch silently
  -- doubles every metric in it.
  dedupe_key    text,

  CONSTRAINT events_identified CHECK (anonymous_id IS NOT NULL OR user_ref IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS events_dedupe_uniq
  ON blocks_analytics.events (dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS events_occurred_idx ON blocks_analytics.events (occurred_at);
CREATE INDEX IF NOT EXISTS events_name_occurred_idx
  ON blocks_analytics.events (event_name, occurred_at);
-- Serves per-actor timelines and the sessionization window function.
CREATE INDEX IF NOT EXISTS events_actor_idx
  ON blocks_analytics.events (COALESCE(user_ref, anonymous_id), occurred_at);
-- Finds events awaiting sessionization without scanning the whole table.
CREATE INDEX IF NOT EXISTS events_unsessionized_idx
  ON blocks_analytics.events (occurred_at) WHERE session_id IS NULL;
CREATE INDEX IF NOT EXISTS events_properties_idx
  ON blocks_analytics.events USING gin (properties);

CREATE TABLE IF NOT EXISTS blocks_analytics.sessions (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_ref     text        NOT NULL,
  started_at    timestamptz NOT NULL,
  ended_at      timestamptz NOT NULL,
  event_count   integer     NOT NULL DEFAULT 0,
  -- First and last event names, which is most of what a session summary gets used for.
  entry_event   text,
  exit_event    text,

  CONSTRAINT sessions_times_sane CHECK (ended_at >= started_at)
);

CREATE INDEX IF NOT EXISTS sessions_actor_idx ON blocks_analytics.sessions (actor_ref, started_at);
CREATE INDEX IF NOT EXISTS sessions_started_idx ON blocks_analytics.sessions (started_at);

-- Daily aggregates. These outlive raw events, so long-range trends survive the retention purge.
CREATE TABLE IF NOT EXISTS blocks_analytics.daily_events (
  day           date        NOT NULL,
  event_name    text        NOT NULL,
  event_count   bigint      NOT NULL DEFAULT 0,
  -- Distinct actors, not event count: one user firing an event fifty times is one active user.
  unique_actors bigint      NOT NULL DEFAULT 0,

  PRIMARY KEY (day, event_name)
);

-- First-seen per actor, anchoring retention cohorts.
CREATE TABLE IF NOT EXISTS blocks_analytics.actor_cohorts (
  actor_ref     text        PRIMARY KEY,
  first_seen_at timestamptz NOT NULL,
  cohort_week   date        NOT NULL,
  last_seen_at  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS actor_cohorts_week_idx
  ON blocks_analytics.actor_cohorts (cohort_week, last_seen_at);`,
    statusView: `
  (SELECT count(*) FROM blocks_analytics.events)                        AS events_total,
  (SELECT count(*) FROM blocks_analytics.events
     WHERE received_at > now() - interval '1 day')                      AS events_last_day,

  -- Events with no session. A growing number means the rollup cron is not running, so every
  -- session-based metric is progressively more wrong.
  (SELECT count(*) FROM blocks_analytics.events WHERE session_id IS NULL) AS events_unsessionized,

  -- Client clocks are unreliable, and a large gap between asserted and received time distorts
  -- ordering. Worth surfacing rather than discovering via a funnel that makes no sense.
  (SELECT count(*) FROM blocks_analytics.events
     WHERE occurred_at > received_at + interval '1 hour')               AS events_future_dated,

  (SELECT count(*) FROM blocks_analytics.sessions)                      AS sessions_total,
  (SELECT count(*) FROM blocks_analytics.actor_cohorts)                 AS actors_total,
  (SELECT count(*) FROM blocks_analytics.daily_events)                  AS daily_rollup_rows,
  (SELECT COALESCE(max(day)::text, 'never') FROM blocks_analytics.daily_events)
                                                                        AS latest_rollup_day,
  (SELECT count(DISTINCT event_name) FROM blocks_analytics.events)      AS event_names`,
    dropOrder: [
      "TABLE blocks_analytics.actor_cohorts",
      "TABLE blocks_analytics.daily_events",
      "TABLE blocks_analytics.sessions",
      "TABLE blocks_analytics.events",
    ],
    routes: [
      { method: "POST", path: "/track", purpose: "Ingest a batch of events, idempotently." },
      { method: "POST", path: "/rollup", purpose: "Cron. Sessionize and aggregate." },
      { method: "GET", path: "/funnel", purpose: "Ordered-step funnel conversion." },
      { method: "GET", path: "/retention", purpose: "Cohort retention by week." },
    ],
    imports: [],
    handlerBody: `
router.post("/track", async (request) => {
  const body = await readJsonObject(request);
  const cfg = config();
  const maxBatch = cfg.int("ANALYTICS_MAX_BATCH", { min: 1, max: 10_000 });

  const events = Array.isArray(body["events"]) ? body["events"] : [body];
  if (events.length > maxBatch) {
    return problem(413, "batch_too_large", \`Batch of \${events.length} exceeds \${maxBatch}\`);
  }

  // One multi-row INSERT rather than a loop: a 1000-event batch as 1000 round trips would hold the
  // invocation open far longer than the work requires.
  const values: unknown[] = [];
  const tuples: string[] = [];

  for (const raw of events) {
    if (typeof raw !== "object" || raw === null) {
      throw new ValidationError("Each event must be an object");
    }
    const e = raw as Record<string, unknown>;
    const eventName = e["event"] ?? e["eventName"];
    if (typeof eventName !== "string" || eventName === "") {
      throw new ValidationError('Each event needs a non-empty "event" name');
    }
    if (typeof e["anonymousId"] !== "string" && typeof e["userRef"] !== "string") {
      throw new ValidationError('Each event needs "anonymousId" or "userRef"');
    }

    const base = values.length;
    values.push(
      e["anonymousId"] ?? null,
      e["userRef"] ?? null,
      eventName,
      JSON.stringify(e["properties"] ?? {}),
      typeof e["occurredAt"] === "string" ? e["occurredAt"] : null,
      typeof e["dedupeKey"] === "string" ? e["dedupeKey"] : null,
    );
    tuples.push(
      \`($\${base + 1}, $\${base + 2}, $\${base + 3}, $\${base + 4}::jsonb, \` +
        \`COALESCE($\${base + 5}::timestamptz, now()), $\${base + 6})\`,
    );
  }

  // ON CONFLICT DO NOTHING on the dedupe key: clients batch and retry, and without this a retried
  // batch silently doubles every metric it contains.
  const { rowCount } = await getPool().query(
    \`INSERT INTO blocks_analytics.events
       (anonymous_id, user_ref, event_name, properties, occurred_at, dedupe_key)
     VALUES \${tuples.join(", ")}
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING\`,
    values,
  );

  const accepted = rowCount ?? 0;
  return json(
    { accepted, submitted: events.length, deduplicated: events.length - accepted },
    { status: 202 },
  );
});

router.post("/rollup", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", \`/rollup expects a schedule trigger, got \${event.type}\`);
  }

  const cfg = config();
  const gapMinutes = cfg.int("ANALYTICS_SESSION_GAP_MINUTES", { min: 1, max: 1_440 });
  const pool = getPool();

  // Sessionization by inactivity gap using a window function. NOT a fixed clock window: a user
  // active 10:55-11:05 is one session, and calendar-hour bucketing would split them and halve the
  // session count.
  //
  // lag() gives each event its predecessor's time for the same actor; a gap over the threshold starts
  // a new session, and a running sum of those boundaries numbers them.
  const { rows: sessionized } = await pool.query<{ sessions: string; events: string }>(
    \`WITH gapped AS (
       SELECT id,
              COALESCE(user_ref, anonymous_id) AS actor_ref,
              event_name,
              occurred_at,
              CASE
                WHEN lag(occurred_at) OVER w IS NULL THEN 1
                WHEN occurred_at - lag(occurred_at) OVER w > make_interval(mins => $1::int) THEN 1
                ELSE 0
              END AS is_new_session
       FROM blocks_analytics.events
       WHERE session_id IS NULL
       WINDOW w AS (PARTITION BY COALESCE(user_ref, anonymous_id) ORDER BY occurred_at)
     ),
     numbered AS (
       SELECT id, actor_ref, event_name, occurred_at,
              sum(is_new_session) OVER (PARTITION BY actor_ref ORDER BY occurred_at) AS session_seq
       FROM gapped
     ),
     bounds AS (
       SELECT actor_ref, session_seq,
              min(occurred_at) AS started_at,
              max(occurred_at) AS ended_at,
              count(*)         AS event_count,
              (array_agg(event_name ORDER BY occurred_at))[1] AS entry_event,
              (array_agg(event_name ORDER BY occurred_at DESC))[1] AS exit_event
       FROM numbered
       GROUP BY actor_ref, session_seq
     ),
     created AS (
       INSERT INTO blocks_analytics.sessions
         (actor_ref, started_at, ended_at, event_count, entry_event, exit_event)
       SELECT actor_ref, started_at, ended_at, event_count, entry_event, exit_event FROM bounds
       RETURNING id, actor_ref, started_at, ended_at
     ),
     linked AS (
       UPDATE blocks_analytics.events e
       SET session_id = created.id
       FROM created
       WHERE COALESCE(e.user_ref, e.anonymous_id) = created.actor_ref
         AND e.occurred_at BETWEEN created.started_at AND created.ended_at
         AND e.session_id IS NULL
       RETURNING e.id
     )
     SELECT (SELECT count(*)::text FROM created) AS sessions,
            (SELECT count(*)::text FROM linked)  AS events\`,
    [gapMinutes],
  );

  // Daily aggregates. Distinct actors rather than event count: one user firing an event fifty times
  // is one active user, and conflating them overstates engagement.
  const { rowCount: dailyRows } = await pool.query(
    \`INSERT INTO blocks_analytics.daily_events (day, event_name, event_count, unique_actors)
     SELECT date_trunc('day', occurred_at)::date,
            event_name,
            count(*),
            count(DISTINCT COALESCE(user_ref, anonymous_id))
     FROM blocks_analytics.events
     WHERE occurred_at >= date_trunc('day', now() - interval '2 days')
     GROUP BY 1, 2
     ON CONFLICT (day, event_name) DO UPDATE
       SET event_count = EXCLUDED.event_count,
           unique_actors = EXCLUDED.unique_actors\`,
  );

  // First-seen per actor, anchoring retention cohorts. LEAST/GREATEST so a late-arriving older event
  // correctly moves the cohort earlier rather than being ignored.
  const { rowCount: cohortRows } = await pool.query(
    \`INSERT INTO blocks_analytics.actor_cohorts (actor_ref, first_seen_at, cohort_week, last_seen_at)
     SELECT COALESCE(user_ref, anonymous_id),
            min(occurred_at),
            date_trunc('week', min(occurred_at))::date,
            max(occurred_at)
     FROM blocks_analytics.events
     GROUP BY 1
     ON CONFLICT (actor_ref) DO UPDATE
       SET first_seen_at = LEAST(blocks_analytics.actor_cohorts.first_seen_at, EXCLUDED.first_seen_at),
           cohort_week = date_trunc('week',
             LEAST(blocks_analytics.actor_cohorts.first_seen_at, EXCLUDED.first_seen_at))::date,
           last_seen_at = GREATEST(blocks_analytics.actor_cohorts.last_seen_at, EXCLUDED.last_seen_at)\`,
  );

  const result = {
    sessionsCreated: Number(sessionized[0]?.sessions ?? 0),
    eventsSessionized: Number(sessionized[0]?.events ?? 0),
    dailyRowsWritten: dailyRows ?? 0,
    cohortRowsWritten: cohortRows ?? 0,
  };
  log.info("analytics rollup complete", result);
  return json({ ok: true, scheduledAt: event.scheduledAt, ...result });
});

router.get("/funnel", async (_request, ctx) => {
  const steps = ctx.url.searchParams.get("steps");
  if (!steps) {
    throw new ValidationError("?steps= is required, e.g. ?steps=view,add_to_cart,checkout");
  }

  const stepNames = steps.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (stepNames.length < 2) throw new ValidationError("A funnel needs at least two steps");

  // TODO(analytics): ordered-step funnel.
  //   Each step must occur AFTER the previous one for the same actor. A query that merely counts
  //   actors who did all the steps inflates conversion: someone who checked out before adding to
  //   cart has not converted through the funnel.
  //   Shape: lateral joins per step, or min(occurred_at) per (actor, step) with a monotonicity check
  //   across steps. A conversion window (all steps within N days) should be a parameter.
  return json({
    steps: stepNames,
    results: [],
    note:
      "Funnel analysis is not yet wired. See the TODO in src/index.ts -- steps must be ordered per " +
      "actor, since counting actors who did all steps in any order overstates conversion.",
  });
});

router.get("/retention", async (_request, ctx) => {
  const weeks = Math.min(Number(ctx.url.searchParams.get("weeks") ?? "12"), 52);

  // Cohort sizes are real; the per-period return rates are the remaining work.
  const { rows } = await getPool().query(
    \`SELECT cohort_week, count(*) AS cohort_size
     FROM blocks_analytics.actor_cohorts
     WHERE cohort_week >= date_trunc('week', now() - make_interval(weeks => $1::int))::date
     GROUP BY cohort_week
     ORDER BY cohort_week\`,
    [weeks],
  );

  // TODO(analytics): the retention matrix. For each cohort, the fraction still active in week 1, 2,
  // 3... Join actor_cohorts to sessions and bucket by weeks-since-first-seen. A single retention
  // number hides whether the product is improving, which is the whole reason to compute cohorts.
  return json({
    cohorts: rows,
    matrix: [],
    note: "Retention rates are not yet wired; cohort sizes above are real.",
  });
});`,
    healthEval: `
      const unsessionized = Number(status["events_unsessionized"] ?? 0);
      const futureDated = Number(status["events_future_dated"] ?? 0);
      const latestRollup = String(status["latest_rollup_day"] ?? "never");

      if (unsessionized > 10_000) {
        problems.push(
          \`\${unsessionized} event(s) are unsessionized; the /rollup trigger may be disabled, so \` +
            \`every session-based metric is progressively more wrong\`,
        );
      }
      if (latestRollup === "never") problems.push("no daily rollups have ever been computed");
      if (futureDated > 0) {
        problems.push(
          \`\${futureDated} event(s) have a client timestamp over an hour ahead of receipt, which \` +
            \`distorts event ordering and any funnel built on it\`,
        );
      }`,
  },

  {
    slug: "db-health",
    rank: 25,
    name: "Database Health Pack",
    summary:
      "Slow-query digest, unused-index and bloat detection, long-transaction alerts, and trend comparison across snapshots.",
    billing: "free",
    capabilities: ["postgres", "branching"],
    dependsOn: [],
    why:
      "Cheap to build and it makes the platform feel like it is looking after you. Every one of these\n" +
      "questions is answerable from Postgres' own catalogs, but nobody remembers to ask until something\n" +
      "is already slow. The schema-drift check is the Neon-specific one: comparing a branch against its\n" +
      "parent catches the migration applied in dev and forgotten in production, which is a class of\n" +
      "outage that branching makes easier to create.",
    notes: [
      "**Snapshots are stored, not just reported.** One reading of `pg_stat_statements` tells you what is slow now; a series tells you what got *slower*, which is the actionable version.",
      "**Unused-index findings carry the stats-reset age inline.** `idx_scan = 0` on a database restarted yesterday means nothing — the counters reset. Without that context the advice is actively harmful, so it is embedded in the finding text rather than left to a footnote.",
      "**Constraint-backing indexes are never suggested for dropping.** Dropping a unique or primary index would drop the constraint with it, so they are excluded from the query outright.",
      "**Advice is suggested, never applied.** `CREATE INDEX` or `VACUUM` on a large production table is a real operation with real cost, and a block that ran them automatically would eventually do so at the worst moment.",
      "**Long-transaction detection is the highest-value cheap check here.** One forgotten session holds back vacuum for the entire database, so bloat appears everywhere and the cause is not local to the table that looks bloated.",
    ],
    limits: [
      "**`pg_stat_statements` may be unavailable.** It requires `shared_preload_libraries`, which is not settable per-database. The block detects its absence and reports it, rather than returning zero slow queries that read as a healthy database.",
      "**Schema-drift comparison is a TODO seam.** It needs a second connection to the parent branch, and credentials for that are not something a block can assume it has.",
      "**The capacity-hours cost monitor is a TODO seam** and can only ever be an estimate: it needs function invocation data this block cannot read.",
      "**Bloat is inferred from `n_dead_tup`, not measured.** That is the real counter rather than a statistical estimate, but it reflects tuples awaiting vacuum rather than physical file bloat. `pgstattuple` is exact and scans the table.",
      "**No alerting.** Findings are recorded and exposed; delivering them is block 13's job, and wiring the two together is left to the user.",
    ],
    env: [
      INJECTED_DB,
      {
        name: "HEALTH_SLOW_QUERY_MS",
        description: "Mean execution time above which a statement is recorded.",
        required: false,
        default: "100",
      },
      {
        name: "HEALTH_BLOAT_WARN_PCT",
        description: "Dead-tuple percentage that triggers a finding.",
        required: false,
        default: "20",
      },
      {
        name: "HEALTH_MIN_TABLE_BYTES",
        description:
          "Ignore objects smaller than this. Percentages on tiny tables are noise, and reporting them buries the real findings.",
        required: false,
        default: "10485760",
      },
      {
        name: "HEALTH_SNAPSHOT_RETENTION_DAYS",
        description: "How long snapshots are kept for trend comparison.",
        required: false,
        default: "90",
      },
      TRIGGER_SECRET,
    ],
    triggers: [
      {
        type: "schedule",
        cron: "7 6 * * *",
        functionPath: "/snapshot",
        description:
          "Take a daily snapshot and record findings. One reading shows what is slow; a series shows what got slower.",
      },
    ],
    tables: `
-- A point-in-time reading of the catalogs. Stored rather than only reported, because one reading
-- tells you what is slow now and a series tells you what got slower.
CREATE TABLE IF NOT EXISTS blocks_db_health.snapshots (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  taken_at        timestamptz NOT NULL DEFAULT now(),

  -- How long since stats were reset. Essential context: idx_scan = 0 on a database restarted
  -- yesterday means nothing, because the counters reset.
  stats_age_seconds bigint,
  database_bytes   bigint,
  connection_count integer,

  -- False when pg_stat_statements is unavailable, so absent query findings are distinguishable from
  -- a genuinely healthy database.
  has_statements_ext boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS snapshots_taken_idx ON blocks_db_health.snapshots (taken_at DESC);

-- Findings, one row per issue per snapshot. Trended rather than replaced, so "this index has been
-- unused for three months" is answerable.
CREATE TABLE IF NOT EXISTS blocks_db_health.findings (
  id              bigserial   PRIMARY KEY,
  snapshot_id     uuid        NOT NULL REFERENCES blocks_db_health.snapshots(id) ON DELETE CASCADE,

  kind            text        NOT NULL,
  severity        text        NOT NULL DEFAULT 'info',
  object_name     text,
  detail          text        NOT NULL,
  metrics         jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- SQL that would address it. SUGGESTED, never executed: CREATE INDEX or VACUUM on a large
  -- production table is a real operation, and a block that ran it automatically would eventually do
  -- so at the worst possible moment.
  suggested_sql   text,

  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT findings_kind_valid CHECK (kind IN (
    'slow_query', 'missing_index', 'unused_index', 'duplicate_index',
    'table_bloat', 'schema_drift', 'capacity_cost', 'long_transaction', 'connection_pressure'
  )),
  CONSTRAINT findings_severity_valid CHECK (severity IN ('info', 'warn', 'critical'))
);

CREATE INDEX IF NOT EXISTS findings_snapshot_idx ON blocks_db_health.findings (snapshot_id, kind);
CREATE INDEX IF NOT EXISTS findings_kind_idx ON blocks_db_health.findings (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS findings_severity_idx
  ON blocks_db_health.findings (severity, created_at DESC)
  WHERE severity IN ('warn', 'critical');

-- Per-statement timing across snapshots, for trend detection.
CREATE TABLE IF NOT EXISTS blocks_db_health.query_stats (
  snapshot_id     uuid        NOT NULL REFERENCES blocks_db_health.snapshots(id) ON DELETE CASCADE,
  -- pg_stat_statements queryid, stable across restarts for the same normalized statement.
  query_id        bigint      NOT NULL,
  query_text      text,
  calls           bigint      NOT NULL DEFAULT 0,
  total_ms        double precision NOT NULL DEFAULT 0,
  mean_ms         double precision NOT NULL DEFAULT 0,
  rows_returned   bigint      NOT NULL DEFAULT 0,

  PRIMARY KEY (snapshot_id, query_id)
);

CREATE INDEX IF NOT EXISTS query_stats_mean_idx ON blocks_db_health.query_stats (mean_ms DESC);`,
    statusView: `
  (SELECT count(*) FROM blocks_db_health.snapshots)                     AS snapshots_total,
  (SELECT COALESCE(max(taken_at)::text, 'never') FROM blocks_db_health.snapshots)
                                                                        AS latest_snapshot,
  -- Stale snapshots mean the cron is not running, so every finding below is out of date.
  (SELECT count(*) FROM blocks_db_health.snapshots
     WHERE taken_at > now() - interval '2 days')                         AS snapshots_recent,

  (SELECT count(*) FROM blocks_db_health.findings f
     WHERE f.severity = 'critical'
       AND f.snapshot_id = (SELECT id FROM blocks_db_health.snapshots
                            ORDER BY taken_at DESC LIMIT 1))             AS findings_critical,
  (SELECT count(*) FROM blocks_db_health.findings f
     WHERE f.severity = 'warn'
       AND f.snapshot_id = (SELECT id FROM blocks_db_health.snapshots
                            ORDER BY taken_at DESC LIMIT 1))             AS findings_warn,

  -- Whether query analysis is possible at all. False means findings are absent because the extension
  -- is missing, not because the database is healthy.
  (SELECT COALESCE(bool_or(has_statements_ext), false) FROM blocks_db_health.snapshots
     WHERE taken_at > now() - interval '2 days')                         AS statements_ext_available,
  (SELECT count(*) FROM blocks_db_health.query_stats)                    AS query_stat_rows`,
    dropOrder: [
      "TABLE blocks_db_health.query_stats",
      "TABLE blocks_db_health.findings",
      "TABLE blocks_db_health.snapshots",
    ],
    routes: [
      { method: "POST", path: "/snapshot", purpose: "Cron. Take a snapshot and record findings." },
      { method: "GET", path: "/findings", purpose: "Findings from the latest snapshot." },
      { method: "GET", path: "/trends", purpose: "Statements whose mean time is rising." },
    ],
    imports: [],
    handlerBody: `
router.post("/snapshot", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", \`/snapshot expects a schedule trigger, got \${event.type}\`);
  }

  const cfg = config();
  const pool = getPool();

  // Check availability before querying. pg_stat_statements needs shared_preload_libraries, which is
  // not settable per-database, so its absence is a platform fact rather than a misconfiguration --
  // and reporting zero slow queries because the extension is missing would be a lie.
  const { rows: ext } = await pool.query<{ available: boolean }>(
    \`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS available\`,
  );
  const hasStatements = ext[0]?.available === true;

  const { rows: snap } = await pool.query<{ id: string }>(
    \`INSERT INTO blocks_db_health.snapshots
       (stats_age_seconds, database_bytes, connection_count, has_statements_ext)
     VALUES (
       (SELECT EXTRACT(EPOCH FROM (now() - stats_reset))::bigint
          FROM pg_stat_database WHERE datname = current_database()),
       pg_database_size(current_database()),
       (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()),
       $1
     )
     RETURNING id\`,
    [hasStatements],
  );

  const snapshotId = snap[0]?.id;
  if (!snapshotId) throw new Error("Failed to record snapshot");

  let findingsRecorded = 0;

  // Unused indexes. The stats-reset age is embedded in the finding text, because idx_scan = 0 on a
  // recently-restarted database means nothing and the advice would be actively harmful without it.
  const { rowCount: unused } = await pool.query(
    \`INSERT INTO blocks_db_health.findings
       (snapshot_id, kind, severity, object_name, detail, metrics, suggested_sql)
     SELECT $1,
            'unused_index',
            'info',
            s.schemaname || '.' || s.indexrelname,
            format(
              'Index has %s scans and occupies %s. Statistics were reset %s ago -- if that is ' ||
              'recent, this finding is not yet meaningful.',
              s.idx_scan,
              pg_size_pretty(pg_relation_size(s.indexrelid)),
              (SELECT COALESCE(age(now(), stats_reset)::text, 'unknown')
                 FROM pg_stat_database WHERE datname = current_database())
            ),
            jsonb_build_object('idx_scan', s.idx_scan,
                               'size_bytes', pg_relation_size(s.indexrelid)),
            format('DROP INDEX %I.%I;', s.schemaname, s.indexrelname)
     FROM pg_stat_user_indexes s
     JOIN pg_index i ON i.indexrelid = s.indexrelid
     WHERE s.idx_scan = 0
       -- Never suggest dropping a constraint-backing index: it would drop the constraint with it.
       AND NOT i.indisunique
       AND NOT i.indisprimary
       AND pg_relation_size(s.indexrelid) > $2
       AND s.schemaname NOT LIKE 'blocks_%'\`,
    [snapshotId, cfg.int("HEALTH_MIN_TABLE_BYTES", { min: 0 })],
  );
  findingsRecorded += unused ?? 0;

  // Tables likely needing a vacuum. Uses the real dead-tuple counter rather than a statistical bloat
  // estimate -- simpler and more trustworthy, though it reflects tuples awaiting vacuum rather than
  // physical file bloat.
  const { rowCount: bloat } = await pool.query(
    \`INSERT INTO blocks_db_health.findings
       (snapshot_id, kind, severity, object_name, detail, metrics, suggested_sql)
     SELECT $1,
            'table_bloat',
            CASE WHEN 100.0 * n_dead_tup / GREATEST(n_live_tup + n_dead_tup, 1) > 40
                 THEN 'warn' ELSE 'info' END,
            schemaname || '.' || relname,
            format('%s dead tuples versus %s live (%s%%). Last autovacuum: %s.',
                   n_dead_tup, n_live_tup,
                   round(100.0 * n_dead_tup / GREATEST(n_live_tup + n_dead_tup, 1), 1),
                   COALESCE(last_autovacuum::text, 'never')),
            jsonb_build_object('dead_tuples', n_dead_tup, 'live_tuples', n_live_tup),
            format('VACUUM ANALYZE %I.%I;', schemaname, relname)
     FROM pg_stat_user_tables
     WHERE n_dead_tup > 1000
       AND 100.0 * n_dead_tup / GREATEST(n_live_tup + n_dead_tup, 1) > $2
       AND pg_relation_size(relid) > $3\`,
    [
      snapshotId,
      cfg.int("HEALTH_BLOAT_WARN_PCT", { min: 1, max: 100 }),
      cfg.int("HEALTH_MIN_TABLE_BYTES", { min: 0 }),
    ],
  );
  findingsRecorded += bloat ?? 0;

  // Long-running transactions. The highest-value cheap check here: one forgotten session holds back
  // vacuum for the ENTIRE database, so bloat appears everywhere and the cause is not local to the
  // table that looks bloated.
  const { rowCount: longTx } = await pool.query(
    \`INSERT INTO blocks_db_health.findings
       (snapshot_id, kind, severity, object_name, detail, metrics)
     SELECT $1,
            'long_transaction',
            'warn',
            'pid ' || pid,
            format('Transaction open for %s in state %s. Long transactions hold back vacuum for ' ||
                   'the entire database, so one forgotten session causes bloat everywhere.',
                   age(now(), xact_start), state),
            jsonb_build_object('pid', pid, 'state', state,
                               'seconds', EXTRACT(EPOCH FROM (now() - xact_start))::bigint)
     FROM pg_stat_activity
     WHERE xact_start IS NOT NULL
       AND now() - xact_start > interval '10 minutes'
       AND datname = current_database()
       AND pid <> pg_backend_pid()\`,
    [snapshotId],
  );
  findingsRecorded += longTx ?? 0;

  // Slow statements, only when the extension exists.
  let slowQueries = 0;
  if (hasStatements) {
    const { rowCount } = await pool.query(
      \`INSERT INTO blocks_db_health.query_stats
         (snapshot_id, query_id, query_text, calls, total_ms, mean_ms, rows_returned)
       SELECT $1, queryid, left(query, 2000), calls, total_exec_time, mean_exec_time, rows
       FROM pg_stat_statements
       WHERE mean_exec_time > $2
         AND query NOT LIKE '%pg_stat_statements%'
       ORDER BY mean_exec_time DESC
       LIMIT 100\`,
      [snapshotId, cfg.int("HEALTH_SLOW_QUERY_MS", { min: 1 })],
    );
    slowQueries = rowCount ?? 0;
  }

  // TODO(db-health): the two remaining checks.
  //   * schema drift against a parent branch. The Neon-specific one and the most valuable: it catches
  //     the migration applied in dev and forgotten in prod. Needs a second connection to the parent,
  //     and credentials for that are not something a block can assume it has.
  //   * capacity-hours cost monitor. Active is 4x waiting, NOT 40x -- the free tier's 10:400 split is
  //     a quota ratio and is widely misread. Flagging CPU-bound functions is how a user learns which
  //     of their blocks are expensive. Needs invocation data this block cannot read, so it could only
  //     ever be an estimate.

  // Prune old snapshots. Findings and query_stats cascade with them.
  await pool.query(
    \`DELETE FROM blocks_db_health.snapshots
     WHERE taken_at < now() - make_interval(days => $1::int)\`,
    [cfg.int("HEALTH_SNAPSHOT_RETENTION_DAYS", { min: 1, max: 3_650 })],
  );

  const result = {
    snapshotId,
    findingsRecorded,
    slowQueriesRecorded: slowQueries,
    statementsExtAvailable: hasStatements,
  };
  log.info("health snapshot complete", result);

  return json({
    ok: true,
    scheduledAt: event.scheduledAt,
    ...result,
    note: hasStatements
      ? undefined
      : "pg_stat_statements is not installed, so no query analysis was possible. It must be in " +
        "shared_preload_libraries, which is not settable per-database.",
  });
});

router.get("/findings", async (_request, ctx) => {
  const kind = ctx.url.searchParams.get("kind");

  // Latest snapshot only: older findings are kept for trends, but showing them all at once would mix
  // resolved issues with live ones.
  const { rows } = await getPool().query(
    \`SELECT f.kind, f.severity, f.object_name, f.detail, f.metrics, f.suggested_sql, s.taken_at
     FROM blocks_db_health.findings f
     JOIN blocks_db_health.snapshots s ON s.id = f.snapshot_id
     WHERE s.id = (SELECT id FROM blocks_db_health.snapshots ORDER BY taken_at DESC LIMIT 1)
       AND ($1::text IS NULL OR f.kind = $1)
     ORDER BY CASE f.severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END,
              f.kind, f.object_name\`,
    [kind],
  );

  return json({
    count: rows.length,
    findings: rows,
    // Repeated on every response: CREATE INDEX and VACUUM on a large production table are real
    // operations, and this block deliberately never runs them.
    note: "suggested_sql is a suggestion, never executed automatically. Review before applying.",
  });
});

router.get("/trends", async (_request, ctx) => {
  const limit = Math.min(Number(ctx.url.searchParams.get("limit") ?? "20"), 100);

  // What got slower, which is the actionable version of "what is slow". Compares each statement's
  // most recent mean against its oldest retained one.
  const { rows } = await getPool().query(
    \`WITH ranked AS (
       SELECT q.query_id,
              q.query_text,
              first_value(q.mean_ms) OVER (PARTITION BY q.query_id ORDER BY s.taken_at DESC) AS latest_ms,
              first_value(q.mean_ms) OVER (PARTITION BY q.query_id ORDER BY s.taken_at ASC)  AS earliest_ms
       FROM blocks_db_health.query_stats q
       JOIN blocks_db_health.snapshots s ON s.id = q.snapshot_id
     )
     SELECT DISTINCT query_id,
            left(query_text, 200) AS query_text,
            round(earliest_ms::numeric, 2) AS earliest_mean_ms,
            round(latest_ms::numeric, 2)   AS latest_mean_ms,
            round((latest_ms - earliest_ms)::numeric, 2) AS delta_ms
     FROM ranked
     WHERE latest_ms > earliest_ms * 1.5
       AND latest_ms > 10
     ORDER BY delta_ms DESC
     LIMIT $1\`,
    [limit],
  );

  return json({ count: rows.length, regressions: rows });
});`,
    healthEval: `
      const recent = Number(status["snapshots_recent"] ?? 0);
      const critical = Number(status["findings_critical"] ?? 0);
      const warn = Number(status["findings_warn"] ?? 0);
      const hasExt = status["statements_ext_available"] === true;

      if (recent === 0) {
        problems.push(
          "no snapshot in the last two days; the /snapshot trigger may be disabled, so every " +
            "finding is out of date",
        );
      }
      if (critical > 0) problems.push(\`\${critical} critical finding(s) in the latest snapshot\`);
      if (warn > 0) problems.push(\`\${warn} warning(s) in the latest snapshot\`);
      if (recent > 0 && !hasExt) {
        // Absence of query findings must not read as a healthy database.
        problems.push(
          "pg_stat_statements is unavailable, so no query analysis is possible. Absent slow-query " +
            "findings do not mean there are none.",
        );
      }`,
  },
];
