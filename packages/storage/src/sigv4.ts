/**
 * Minimal AWS SigV4 for S3-compatible endpoints.
 *
 * Hand-rolled rather than depending on `@aws-sdk/client-s3`: the SDK is tens of megabytes and
 * every dependency is one more thing that can break the esbuild single-file bundle path that
 * makes `neon-blocks add` a one-command install (convention §12). We need five operations, not
 * a whole service client.
 *
 * Pure functions, separately testable — signing bugs are notoriously hard to debug against a
 * live endpoint, where every failure looks like 403.
 */

import { createHash, createHmac } from "node:crypto";

export interface SigV4Input {
  method: string;
  /** Already-encoded path beginning with "/". */
  path: string;
  query?: Record<string, string>;
  headers: Record<string, string>;
  /** Hex SHA-256 of the body, or "UNSIGNED-PAYLOAD". */
  payloadHash: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** ISO basic format: 20260922T104500Z. Injectable for deterministic tests. */
  amzDate: string;
}

export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
export const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/**
 * S3 requires each path segment percent-encoded, but NOT the separating slashes.
 *
 * `encodeURIComponent` leaves `!'()*` alone, which S3 expects encoded; getting this wrong
 * produces a signature mismatch only for keys containing those characters, which is the kind
 * of bug that ships and then breaks one customer's file six months later.
 */
export function encodeS3Key(key: string): string {
  return key
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

export function canonicalQueryString(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map(
      (k) =>
        `${encodeURIComponent(k).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}=` +
        `${encodeURIComponent(query[k]!).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    )
    .join("&");
}

export interface SignedRequest {
  authorization: string;
  signedHeaders: string;
  canonicalRequest: string;
  stringToSign: string;
}

/** Build the Authorization header for a request. */
export function signRequest(input: SigV4Input): SignedRequest {
  const dateStamp = input.amzDate.slice(0, 8);
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;

  // Header names lowercased and sorted; values trimmed. Order is part of the signature.
  const normalized = Object.entries(input.headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim()] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const signedHeaders = normalized.map(([k]) => k).join(";");
  const canonicalHeaders = normalized.map(([k, v]) => `${k}:${v}\n`).join("");

  const canonicalRequest = [
    input.method.toUpperCase(),
    input.path,
    canonicalQueryString(input.query ?? {}),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    input.amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, dateStamp), input.region), input.service),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  return {
    authorization:
      `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    signedHeaders,
    canonicalRequest,
    stringToSign,
  };
}

export interface PresignInput {
  method: string;
  bucket: string;
  key: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresInSeconds: number;
  amzDate: string;
  /** Force a content type the client must then match. */
  contentType?: string;
}

/**
 * Presigned URL via query-string auth, for browser uploads and time-limited downloads.
 *
 * This is what lets a client PUT straight to storage without proxying bytes through a
 * function — which matters for cost as much as latency, since a function streaming a 200 MB
 * upload is billing Capacity-Hours to do nothing but copy.
 */
export function presignUrl(input: PresignInput): string {
  if (input.expiresInSeconds < 1 || input.expiresInSeconds > 604_800) {
    throw new Error(
      `expiresInSeconds must be between 1 and 604800 (7 days), got ${input.expiresInSeconds}`,
    );
  }

  const url = new URL(input.endpoint);
  const host = url.host;
  const dateStamp = input.amzDate.slice(0, 8);
  const scope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const path = `/${input.bucket}/${encodeS3Key(input.key)}`;

  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${input.accessKeyId}/${scope}`,
    "X-Amz-Date": input.amzDate,
    "X-Amz-Expires": String(input.expiresInSeconds),
    "X-Amz-SignedHeaders": input.contentType ? "content-type;host" : "host",
  };

  const headers: Record<string, string> = { host };
  if (input.contentType) headers["content-type"] = input.contentType;

  const signed = signRequest({
    method: input.method,
    path,
    query,
    headers,
    payloadHash: UNSIGNED_PAYLOAD,
    region: input.region,
    service: "s3",
    accessKeyId: input.accessKeyId,
    secretAccessKey: input.secretAccessKey,
    amzDate: input.amzDate,
  });

  // Extract just the signature from the Authorization header for query-string form.
  const signature = /Signature=([a-f0-9]+)/.exec(signed.authorization)?.[1];
  if (!signature) throw new Error("Failed to extract signature while presigning");

  return `${url.origin}${path}?${canonicalQueryString({ ...query, "X-Amz-Signature": signature })}`;
}

/** ISO basic timestamp S3 expects: 20260922T104500Z. */
export function amzDate(now: Date = new Date()): string {
  return `${now.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
}
