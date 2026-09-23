/**
 * Digest collapsing. Pure: turn several notifications for one (user, category) into one message,
 * so ten comments on a thread become one email rather than ten.
 */

export interface DigestItem {
  subject?: string | null;
  body: string;
}

/** One digest body summarizing `items` for a category. */
export function buildDigestMessage(category: string, items: readonly DigestItem[]): {
  subject: string;
  body: string;
} {
  const subject = `${items.length} new ${category} notification${items.length === 1 ? "" : "s"}`;
  const lines = items.map((it, i) => {
    const head = it.subject ? `${it.subject}: ` : "";
    return `${i + 1}. ${head}${it.body}`;
  });
  return { subject, body: lines.join("\n") };
}
