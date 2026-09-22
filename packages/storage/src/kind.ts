/**
 * File-kind detection.
 *
 * Storage triggers have **no suffix or content-type filter** — you get every object written to
 * the bucket and must sort them out in-function. That is exactly why the ingest-router block
 * exists, and this is its classification core: pure, table-driven, unit-testable.
 *
 * Content type is checked before extension because extensions lie, and magic bytes are checked
 * last as the tiebreaker when both are unhelpful (`application/octet-stream` with no extension
 * is extremely common from SDK uploads).
 */

export type ObjectKind =
  | "image"
  | "pdf"
  | "document"
  | "spreadsheet"
  | "text"
  | "audio"
  | "video"
  | "archive"
  | "data"
  | "unknown";

const BY_EXTENSION: Readonly<Record<string, ObjectKind>> = {
  // images
  jpg: "image", jpeg: "image", png: "image", gif: "image", webp: "image",
  avif: "image", tiff: "image", tif: "image", bmp: "image", heic: "image", svg: "image",
  // documents
  pdf: "pdf",
  doc: "document", docx: "document", odt: "document", rtf: "document", pages: "document",
  // spreadsheets
  xls: "spreadsheet", xlsx: "spreadsheet", ods: "spreadsheet", csv: "spreadsheet", tsv: "spreadsheet",
  // text
  txt: "text", md: "text", markdown: "text", html: "text", htm: "text", rst: "text",
  // audio / video
  mp3: "audio", wav: "audio", m4a: "audio", flac: "audio", ogg: "audio", aac: "audio",
  mp4: "video", mov: "video", webm: "video", mkv: "video", avi: "video",
  // archives
  zip: "archive", tar: "archive", gz: "archive", tgz: "archive", bz2: "archive",
  rar: "archive", "7z": "archive",
  // structured data
  json: "data", jsonl: "data", ndjson: "data", parquet: "data", avro: "data",
  xml: "data", yaml: "data", yml: "data",
};

const BY_MIME_PREFIX: readonly (readonly [string, ObjectKind])[] = [
  ["image/", "image"],
  ["audio/", "audio"],
  ["video/", "video"],
  ["text/csv", "spreadsheet"],
  ["text/tab-separated-values", "spreadsheet"],
  ["text/", "text"],
  ["application/pdf", "pdf"],
  ["application/json", "data"],
  ["application/x-ndjson", "data"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml", "spreadsheet"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml", "document"],
  ["application/vnd.ms-excel", "spreadsheet"],
  ["application/msword", "document"],
  ["application/vnd.oasis.opendocument.text", "document"],
  ["application/vnd.oasis.opendocument.spreadsheet", "spreadsheet"],
  ["application/zip", "archive"],
  ["application/gzip", "archive"],
  ["application/x-tar", "archive"],
];

/** Magic-byte signatures, checked last. Only formats where sniffing is genuinely decisive. */
const MAGIC: readonly (readonly [readonly number[], ObjectKind])[] = [
  [[0x25, 0x50, 0x44, 0x46], "pdf"], // %PDF
  [[0x89, 0x50, 0x4e, 0x47], "image"], // PNG
  [[0xff, 0xd8, 0xff], "image"], // JPEG
  [[0x47, 0x49, 0x46, 0x38], "image"], // GIF8
  [[0x50, 0x4b, 0x03, 0x04], "archive"], // ZIP — also docx/xlsx, hence extension first
  [[0x1f, 0x8b], "archive"], // gzip
];

export function extensionOf(key: string): string | undefined {
  const base = key.slice(key.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return undefined;
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Classify an object.
 *
 * Returns "unknown" rather than guessing when nothing matches — the router treats unknown as
 * "no handler wanted it" and records that, which is far better than silently routing a
 * mystery file into an image pipeline.
 */
export function detectKind(input: {
  key: string;
  contentType?: string;
  /** First few bytes, when the caller has already read them. */
  head?: Uint8Array;
}): ObjectKind {
  const mime = input.contentType?.toLowerCase().split(";")[0]?.trim();

  // A specific content type beats an extension, but a generic one tells us nothing.
  if (mime && mime !== "application/octet-stream" && mime !== "binary/octet-stream") {
    for (const [prefix, kind] of BY_MIME_PREFIX) {
      if (mime.startsWith(prefix)) return kind;
    }
  }

  const ext = extensionOf(input.key);
  if (ext) {
    const byExt = BY_EXTENSION[ext];
    if (byExt) return byExt;
  }

  if (input.head && input.head.byteLength > 0) {
    for (const [signature, kind] of MAGIC) {
      if (signature.every((byte, i) => input.head![i] === byte)) return kind;
    }
  }

  return "unknown";
}
