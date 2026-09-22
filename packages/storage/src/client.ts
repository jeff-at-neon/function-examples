/**
 * Object Storage client.
 *
 * The critical method is `headVerified`. Because the storage trigger payload is documented as
 * exactly `{bucket_name, object_key}` and delivery is unauthenticated, every storage block
 * must independently establish that the object exists and learn its metadata. That is not
 * overhead to optimise away — it is the security boundary (conventions §6, §7).
 */

import { createHash } from "node:crypto";
import {
  amzDate,
  encodeS3Key,
  EMPTY_SHA256,
  presignUrl,
  signRequest,
  UNSIGNED_PAYLOAD,
} from "./sigv4.js";

export interface StorageConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Read storage credentials from the environment Neon injects.
 *
 * Falls back to AWS-standard names so the same block runs against MinIO locally without a
 * separate code path — a test harness that doesn't resemble production isn't worth much.
 */
export function storageConfigFromEnv(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const endpoint =
    env["NEON_STORAGE_ENDPOINT"] ?? env["AWS_ENDPOINT_URL_S3"] ?? env["AWS_ENDPOINT_URL"];
  const accessKeyId = env["NEON_STORAGE_ACCESS_KEY_ID"] ?? env["AWS_ACCESS_KEY_ID"];
  const secretAccessKey =
    env["NEON_STORAGE_SECRET_ACCESS_KEY"] ?? env["AWS_SECRET_ACCESS_KEY"];
  const region = env["NEON_STORAGE_REGION"] ?? env["AWS_REGION"] ?? "auto";

  const missing = [
    !endpoint && "NEON_STORAGE_ENDPOINT",
    !accessKeyId && "NEON_STORAGE_ACCESS_KEY_ID",
    !secretAccessKey && "NEON_STORAGE_SECRET_ACCESS_KEY",
  ].filter((v): v is string => typeof v === "string");

  if (missing.length > 0) {
    throw new Error(
      `Object Storage is not configured: missing ${missing.join(", ")}. ` +
        `Neon injects these automatically when the branch has Object Storage enabled.`,
    );
  }

  return { endpoint: endpoint!, region, accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! };
}

export interface ObjectMetadata {
  bucket: string;
  key: string;
  /** Byte length. Needed for the size guards every public handler must apply. */
  size: number;
  contentType: string;
  /** Quotes stripped. Half the idempotency contract: key on `(key, etag)`, never key alone. */
  etag: string;
  lastModified: Date | null;
}

export class ObjectNotFoundError extends Error {
  override readonly name = "NotFoundError";
  constructor(bucket: string, key: string) {
    super(`Object not found: ${bucket}/${key}`);
  }
}

export class StorageError extends Error {
  override readonly name = "StorageError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class StorageClient {
  readonly #config: StorageConfig;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(config: StorageConfig, opts: { fetch?: typeof fetch; now?: () => Date } = {}) {
    this.#config = config;
    this.#fetch = opts.fetch ?? fetch;
    this.#now = opts.now ?? (() => new Date());
  }

  static fromEnv(env?: NodeJS.ProcessEnv): StorageClient {
    return new StorageClient(storageConfigFromEnv(env));
  }

  #sign(
    method: string,
    bucket: string,
    key: string,
    payloadHash: string,
    extraHeaders: Record<string, string> = {},
  ): { url: string; headers: Record<string, string> } {
    const endpoint = new URL(this.#config.endpoint);
    const path = `/${bucket}/${encodeS3Key(key)}`;
    const date = amzDate(this.#now());

    const headers: Record<string, string> = {
      host: endpoint.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": date,
      ...extraHeaders,
    };

    const signed = signRequest({
      method,
      path,
      headers,
      payloadHash,
      region: this.#config.region,
      service: "s3",
      accessKeyId: this.#config.accessKeyId,
      secretAccessKey: this.#config.secretAccessKey,
      amzDate: date,
    });

    return {
      url: `${endpoint.origin}${path}`,
      headers: { ...headers, authorization: signed.authorization },
    };
  }

  /**
   * Confirm an object exists and return its real metadata.
   *
   * Every storage-triggered handler starts here. A forged trigger POST naming an object that
   * doesn't exist dies at this call rather than deeper in a pipeline where a half-written row
   * is the outcome.
   */
  async headVerified(bucket: string, key: string): Promise<ObjectMetadata> {
    const { url, headers } = this.#sign("HEAD", bucket, key, EMPTY_SHA256);
    const response = await this.#fetch(url, { method: "HEAD", headers });

    if (response.status === 404) throw new ObjectNotFoundError(bucket, key);
    if (!response.ok) {
      throw new StorageError(
        `HEAD ${bucket}/${key} failed with ${response.status}`,
        response.status,
      );
    }

    const lastModifiedHeader = response.headers.get("last-modified");
    const lastModified = lastModifiedHeader ? new Date(lastModifiedHeader) : null;

    return {
      bucket,
      key,
      size: Number(response.headers.get("content-length") ?? "0"),
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
      etag: (response.headers.get("etag") ?? "").replace(/^"|"$/g, ""),
      lastModified: lastModified && !Number.isNaN(lastModified.getTime()) ? lastModified : null,
    };
  }

  /**
   * Download an object, refusing anything over `maxBytes`.
   *
   * The cap is mandatory, not optional. These endpoints are public and functions run at a
   * fixed size, so an unbounded read is both an OOM and a decompression-bomb vector
   * (convention §11). We check the declared length first, then enforce again while reading,
   * because `content-length` is a claim rather than a fact.
   */
  async getObject(
    bucket: string,
    key: string,
    opts: { maxBytes: number },
  ): Promise<{ body: Uint8Array; metadata: ObjectMetadata }> {
    const metadata = await this.headVerified(bucket, key);
    if (metadata.size > opts.maxBytes) {
      throw new StorageError(
        `Object ${bucket}/${key} is ${metadata.size} bytes, over the ${opts.maxBytes} byte limit`,
        413,
      );
    }

    const { url, headers } = this.#sign("GET", bucket, key, EMPTY_SHA256);
    const response = await this.#fetch(url, { method: "GET", headers });
    if (response.status === 404) throw new ObjectNotFoundError(bucket, key);
    if (!response.ok) {
      throw new StorageError(`GET ${bucket}/${key} failed with ${response.status}`, response.status);
    }

    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > opts.maxBytes) {
      throw new StorageError(
        `Object ${bucket}/${key} streamed ${body.byteLength} bytes, over the ` +
          `${opts.maxBytes} byte limit (declared content-length was ${metadata.size})`,
        413,
      );
    }

    return { body, metadata };
  }

  async putObject(
    bucket: string,
    key: string,
    body: Uint8Array,
    opts: { contentType?: string; cacheControl?: string } = {},
  ): Promise<{ etag: string }> {
    const payloadHash = createHash("sha256").update(body).digest("hex");
    const extra: Record<string, string> = {};
    if (opts.contentType) extra["content-type"] = opts.contentType;
    if (opts.cacheControl) extra["cache-control"] = opts.cacheControl;

    const { url, headers } = this.#sign("PUT", bucket, key, payloadHash, extra);
    const response = await this.#fetch(url, { method: "PUT", headers, body });

    if (!response.ok) {
      throw new StorageError(`PUT ${bucket}/${key} failed with ${response.status}`, response.status);
    }
    return { etag: (response.headers.get("etag") ?? "").replace(/^"|"$/g, "") };
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    const { url, headers } = this.#sign("DELETE", bucket, key, EMPTY_SHA256);
    const response = await this.#fetch(url, { method: "DELETE", headers });
    // S3 returns 204 for both "deleted" and "was never there"; treat 404 as success too.
    if (!response.ok && response.status !== 404) {
      throw new StorageError(
        `DELETE ${bucket}/${key} failed with ${response.status}`,
        response.status,
      );
    }
  }

  /**
   * List objects under a prefix, one page at a time.
   *
   * This is what the reconciliation sweepers walk. Returns the continuation token rather than
   * auto-paginating: a sweeper must be able to stop at a bounded batch and resume next run,
   * instead of holding an invocation open across a million objects.
   */
  async listObjects(
    bucket: string,
    opts: { prefix?: string; maxKeys?: number; continuationToken?: string } = {},
  ): Promise<{ objects: ObjectMetadata[]; nextContinuationToken: string | null }> {
    const endpoint = new URL(this.#config.endpoint);
    const date = amzDate(this.#now());
    const query: Record<string, string> = { "list-type": "2" };
    if (opts.prefix) query["prefix"] = opts.prefix;
    if (opts.maxKeys) query["max-keys"] = String(opts.maxKeys);
    if (opts.continuationToken) query["continuation-token"] = opts.continuationToken;

    const headers: Record<string, string> = {
      host: endpoint.host,
      "x-amz-content-sha256": EMPTY_SHA256,
      "x-amz-date": date,
    };

    const signed = signRequest({
      method: "GET",
      path: `/${bucket}`,
      query,
      headers,
      payloadHash: EMPTY_SHA256,
      region: this.#config.region,
      service: "s3",
      accessKeyId: this.#config.accessKeyId,
      secretAccessKey: this.#config.secretAccessKey,
      amzDate: date,
    });

    const url = `${endpoint.origin}/${bucket}?${new URLSearchParams(query).toString()}`;
    const response = await this.#fetch(url, {
      method: "GET",
      headers: { ...headers, authorization: signed.authorization },
    });

    if (!response.ok) {
      throw new StorageError(`LIST ${bucket} failed with ${response.status}`, response.status);
    }

    return parseListResponse(await response.text(), bucket);
  }

  /** Presigned PUT so a browser uploads directly, without proxying bytes through a function. */
  presignPut(
    bucket: string,
    key: string,
    opts: { expiresInSeconds?: number; contentType?: string } = {},
  ): string {
    return presignUrl({
      method: "PUT",
      bucket,
      key,
      endpoint: this.#config.endpoint,
      region: this.#config.region,
      accessKeyId: this.#config.accessKeyId,
      secretAccessKey: this.#config.secretAccessKey,
      expiresInSeconds: opts.expiresInSeconds ?? 900,
      amzDate: amzDate(this.#now()),
      ...(opts.contentType ? { contentType: opts.contentType } : {}),
    });
  }

  presignGet(bucket: string, key: string, opts: { expiresInSeconds?: number } = {}): string {
    return presignUrl({
      method: "GET",
      bucket,
      key,
      endpoint: this.#config.endpoint,
      region: this.#config.region,
      accessKeyId: this.#config.accessKeyId,
      secretAccessKey: this.#config.secretAccessKey,
      expiresInSeconds: opts.expiresInSeconds ?? 900,
      amzDate: amzDate(this.#now()),
    });
  }
}

/**
 * Parse ListObjectsV2 XML.
 *
 * Regex rather than an XML parser: the response shape is fixed and narrow, and avoiding a
 * dependency keeps the bundle small (convention §12). Deliberately tolerant of attribute
 * order and whitespace.
 */
export function parseListResponse(
  xml: string,
  bucket: string,
): { objects: ObjectMetadata[]; nextContinuationToken: string | null } {
  const objects: ObjectMetadata[] = [];
  const contentsRe = /<Contents>([\s\S]*?)<\/Contents>/g;

  for (const match of xml.matchAll(contentsRe)) {
    const chunk = match[1]!;
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(chunk)?.[1];
    if (!key) continue;

    const lastModifiedRaw = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(chunk)?.[1];
    const lastModified = lastModifiedRaw ? new Date(lastModifiedRaw) : null;

    objects.push({
      bucket,
      key: decodeXmlEntities(key),
      size: Number(/<Size>(\d+)<\/Size>/.exec(chunk)?.[1] ?? "0"),
      // LIST does not return content types; callers needing one must HEAD.
      contentType: "application/octet-stream",
      etag: (/<ETag>([\s\S]*?)<\/ETag>/.exec(chunk)?.[1] ?? "")
        .replace(/&quot;/g, "")
        .replace(/^"|"$/g, ""),
      lastModified: lastModified && !Number.isNaN(lastModified.getTime()) ? lastModified : null,
    });
  }

  const truncated = /<IsTruncated>true<\/IsTruncated>/i.test(xml);
  const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];

  return {
    objects,
    nextContinuationToken: truncated && token ? decodeXmlEntities(token) : null,
  };
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
