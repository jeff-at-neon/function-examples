/**
 * Template rendering. Pure. Escaping is channel-appropriate: user data in an email body is
 * HTML-escaped, because a naive replace() of user-controlled values into HTML is an injection
 * vector. SMS and other plain channels are not escaped.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Substitute {{key}} placeholders. Missing keys render as empty. Email escapes values. */
export function renderString(
  template: string,
  variables: Record<string, unknown>,
  channel: string,
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, key) => {
    const raw = variables[key];
    const value = raw === undefined || raw === null ? "" : String(raw);
    return channel === "email" ? escapeHtml(value) : value;
  });
}

export interface RenderedMessage {
  subject?: string;
  body: string;
}

export function renderTemplate(
  template: { subject?: string | null; body: string },
  variables: Record<string, unknown>,
  channel: string,
): RenderedMessage {
  const body = renderString(template.body, variables, channel);
  if (template.subject != null && template.subject !== "") {
    return { subject: renderString(template.subject, variables, channel), body };
  }
  return { body };
}
