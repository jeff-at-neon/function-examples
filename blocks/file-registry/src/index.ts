/**
 * Block 4 — File Registry + Signed Uploads.
 *
 * Object Storage branches with your data but is unqueryable on its own. This block is the SQL
 * index that makes it useful: joins to your domain tables, per-tenant listings, quotas, and
 * foreign keys.
 *
 * Routes:
 *   POST /uploads      issue a presigned PUT and a pending row
 *   POST /finalize     storage trigger — flip pending to ready with observed metadata
 *   POST /reconcile    cron — missed finalizes, deletions, abandoned uploads
 *   GET  /files        list a tenant's files
 *   DELETE /files/:key remove a file
 *   GET  /health       observability
 */

import {
  assertTriggerAuthentic,
  checkHealth,
  createLogger,
  getPool,
  json,
  loadConfig,
  parseTriggerRequest,
  problem,
  Router,
  ValidationError,
  type Logger,
} from "@neon-blocks/core";
import { autoMigrate } from "@neon-blocks/migrate";
import { StorageClient } from "@neon-blocks/storage";
import { assertKeyBelongsToTenant } from "./keys.js";
import { deleteFile, finalizeUpload, issueUpload, listTenantFiles, reconcile } from "./registry.js";

const log: Logger = createLogger({ block: "file-registry" });

const SPEC = {
  block: "file-registry",
  required: ["REGISTRY_BUCKET"],
  optional: {
    REGISTRY_PREFIX: "uploads/",
    REGISTRY_UPLOAD_TTL_SECONDS: "900",
    REGISTRY_MAX_UPLOAD_BYTES: "104857600",
    REGISTRY_ABANDON_AFTER_MINUTES: "60",
  },
} as const;

function config() {
  const raw = loadConfig(SPEC);
  return {
    bucket: raw.get("REGISTRY_BUCKET"),
    prefix: raw.get("REGISTRY_PREFIX"),
    // Capped at one hour: a presigned PUT is a bearer write grant, and a leaked long-lived URL is
    // an open door. S3 permits seven days; that is almost never the right choice here.
    ttlSeconds: raw.int("REGISTRY_UPLOAD_TTL_SECONDS", { min: 60, max: 3_600 }),
    maxUploadBytes: raw.int("REGISTRY_MAX_UPLOAD_BYTES", { min: 1_024 }),
    abandonAfterMinutes: raw.int("REGISTRY_ABANDON_AFTER_MINUTES", { min: 1, max: 10_080 }),
  };
}

const router = new Router();

router.post("/uploads", async (request) => {
  const body = await readJsonObject(request);
  const cfg = config();

  // NOTE: tenant is taken from the request body, which means this route MUST sit behind your own
  // authentication — otherwise a caller can claim any tenant. See the README; block 12
  // (api-edge) is the intended companion.
  const tenant = requireString(body, "tenant");
  const filename = requireString(body, "filename");

  const issued = await issueUpload(getPool(), {
    bucket: cfg.bucket,
    prefix: cfg.prefix,
    tenant,
    filename,
    maxBytes: cfg.maxUploadBytes,
    ttlSeconds: cfg.ttlSeconds,
    storage: StorageClient.fromEnv(),
    ...(typeof body["owner"] === "string" ? { owner: body["owner"] } : {}),
    ...(typeof body["contentType"] === "string" ? { contentType: body["contentType"] } : {}),
    ...(typeof body["sizeBytes"] === "number" ? { declaredSizeBytes: body["sizeBytes"] } : {}),
    ...(typeof body["metadata"] === "object" && body["metadata"] !== null
      ? { metadata: body["metadata"] as Record<string, unknown> }
      : {}),
  });

  return json(
    {
      id: issued.id,
      objectKey: issued.objectKey,
      uploadUrl: issued.uploadUrl,
      expiresAt: issued.expiresAt.toISOString(),
      method: "PUT",
      maxBytes: cfg.maxUploadBytes,
    },
    { status: 201 },
  );
});

router.post("/finalize", async (request) => {
  assertTriggerAuthentic(request, { requireSecret: false });
  const event = await parseTriggerRequest(request);
  if (event.type !== "storage_object_created") {
    return problem(400, "wrong_trigger", `/finalize expects a storage trigger, got ${event.type}`);
  }

  const cfg = config();
  if (event.bucketName !== cfg.bucket) {
    log.warn("rejecting event for unexpected bucket", {
      received: event.bucketName,
      expected: cfg.bucket,
    });
    return problem(403, "wrong_bucket", `This registry only indexes "${cfg.bucket}"`);
  }

  const result = await finalizeUpload(getPool(), {
    bucket: event.bucketName,
    prefix: cfg.prefix,
    objectKey: event.objectKey,
    storage: StorageClient.fromEnv(),
    logger: log.child({ objectKey: event.objectKey }),
  });

  // Always 200: ignored and rejected are correct terminal outcomes, and a 5xx would invite
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
    prefix: cfg.prefix,
    storage: StorageClient.fromEnv(),
    abandonAfterMinutes: cfg.abandonAfterMinutes,
    logger: log,
  });

  return json({ ok: true, scheduledAt: event.scheduledAt, ...result });
});

router.get("/files", async (_request, ctx) => {
  const cfg = config();
  const tenant = ctx.url.searchParams.get("tenant");
  if (!tenant) throw new ValidationError("?tenant= is required");

  const limit = Number(ctx.url.searchParams.get("limit") ?? "50");
  const offset = Number(ctx.url.searchParams.get("offset") ?? "0");
  if (!Number.isInteger(limit) || limit < 1) throw new ValidationError("limit must be a positive integer");
  if (!Number.isInteger(offset) || offset < 0) throw new ValidationError("offset must be >= 0");

  const files = await listTenantFiles(getPool(), { bucket: cfg.bucket, tenant, limit, offset });

  // Presigned GET per file rather than a public URL: the bucket stays private, and links expire.
  const storage = StorageClient.fromEnv();
  return json({
    tenant,
    count: files.length,
    files: files.map((file) => ({
      ...file,
      downloadUrl: storage.presignGet(cfg.bucket, file.objectKey, { expiresInSeconds: 900 }),
    })),
  });
});

router.add("DELETE", "/files/:key", async (_request, ctx) => {
  const cfg = config();
  const tenant = ctx.url.searchParams.get("tenant");
  if (!tenant) throw new ValidationError("?tenant= is required");

  const objectKey = ctx.params["key"]!;
  // Belt and braces: the SQL also filters on tenant, but failing here keeps a cross-tenant attempt
  // out of the database entirely and logs it as a validation error rather than a silent no-op.
  assertKeyBelongsToTenant(objectKey, tenant, cfg.prefix);

  await deleteFile(getPool(), {
    bucket: cfg.bucket,
    objectKey,
    tenant,
    storage: StorageClient.fromEnv(),
  });

  return json({ deleted: objectKey });
});

router.get("/health", async () => {
  const report = await checkHealth(getPool(), {
    block: "file-registry",
    schema: "blocks_file_registry",
    evaluate: (status) => {
      const problems: string[] = [];
      const stale = Number(status["objects_pending_stale"] ?? 0);
      const rejected = Number(status["objects_rejected"] ?? 0);

      if (stale > 0) {
        problems.push(
          `${stale} upload(s) pending for over an hour. Either clients are abandoning uploads, ` +
            `or the storage trigger is not delivering — check it is enabled on this branch.`,
        );
      }
      if (rejected > 0) {
        problems.push(`${rejected} upload(s) were rejected for exceeding their size limit`);
      }
      return problems;
    },
  });

  return json(report, { status: report.status === "ok" ? 200 : 503 });
});

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new ValidationError("Request body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value === "") {
    throw new ValidationError(`"${key}" is required and must be a non-empty string`);
  }
  return value;
}

export default autoMigrate({
  block: "file-registry",
  migrationsUrl: new URL("./migrations/", import.meta.url),
  fetch: (request: Request): Promise<Response> => router.handle(request),
});

export {
  issueUpload,
  finalizeUpload,
  reconcile,
  listTenantFiles,
  deleteFile,
} from "./registry.js";
export {
  buildObjectKey,
  sanitizeFilename,
  parseTenantFromKey,
  assertKeyBelongsToTenant,
} from "./keys.js";
