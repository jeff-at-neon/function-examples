import { describe, expect, it } from "vitest";
import { escapeHtml, renderString, renderTemplate } from "../src/render.js";
import { buildDigestMessage } from "../src/digest.js";

describe("renderString", () => {
  it("substitutes {{key}} placeholders", () => {
    expect(renderString("Hi {{name}}", { name: "Ada" }, "sms")).toBe("Hi Ada");
  });
  it("renders missing keys as empty", () => {
    expect(renderString("Hi {{name}}!", {}, "sms")).toBe("Hi !");
  });
  // The injection guard: user data in an email body must be HTML-escaped.
  it("HTML-escapes values for email but not for sms", () => {
    const vars = { name: "<script>alert(1)</script>" };
    expect(renderString("Hi {{name}}", vars, "email")).toBe("Hi &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(renderString("Hi {{name}}", vars, "sms")).toBe("Hi <script>alert(1)</script>");
  });
});

describe("escapeHtml", () => {
  it("escapes the five significant characters", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });
});

describe("renderTemplate", () => {
  it("renders subject and body when a subject exists", () => {
    const out = renderTemplate({ subject: "Hi {{name}}", body: "Welcome {{name}}" }, { name: "Ada" }, "email");
    expect(out).toEqual({ subject: "Hi Ada", body: "Welcome Ada" });
  });
  it("omits subject when the template has none", () => {
    const out = renderTemplate({ subject: null, body: "code {{c}}" }, { c: "123" }, "sms");
    expect(out).toEqual({ body: "code 123" });
  });
});

describe("buildDigestMessage", () => {
  it("collapses items into one numbered message", () => {
    const d = buildDigestMessage("comments", [
      { subject: "A", body: "first" },
      { subject: null, body: "second" },
    ]);
    expect(d.subject).toBe("2 new comments notifications");
    expect(d.body).toBe("1. A: first\n2. second");
  });
  it("singularizes one item", () => {
    expect(buildDigestMessage("comment", [{ body: "x" }]).subject).toBe("1 new comment notification");
  });
});
