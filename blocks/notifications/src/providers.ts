/**
 * Provider adapters behind one interface. The dispatch itself (an HTTP call to Resend/SES/Twilio)
 * is the thin untestable edge; provider selection is pure. A "none" provider is the safe default —
 * it refuses rather than silently dropping, so a missing configuration is visible.
 */

import type { NotifyConfig } from "./config.js";

export interface OutboundMessage {
  channel: string;
  to: string;
  from: string;
  subject?: string;
  body: string;
}

export interface Provider {
  name: string;
  send(msg: OutboundMessage): Promise<{ providerMessageId: string }>;
}

class NoneProvider implements Provider {
  name = "none";
  async send(): Promise<{ providerMessageId: string }> {
    throw new Error("no notification provider configured (NOTIFY_EMAIL_PROVIDER=none)");
  }
}

class ResendProvider implements Provider {
  name = "resend";
  #apiKey: string;
  constructor(apiKey: string) {
    this.#apiKey = apiKey;
  }
  async send(msg: OutboundMessage): Promise<{ providerMessageId: string }> {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: msg.from,
        to: msg.to,
        subject: msg.subject ?? "",
        html: msg.body,
      }),
    });
    if (!response.ok) {
      throw new Error(`resend send failed with ${response.status}`);
    }
    const data = (await response.json()) as { id?: string };
    return { providerMessageId: data.id ?? "" };
  }
}

/** Pick the email provider from config. Extend here as more adapters are added. */
export function selectEmailProvider(cfg: NotifyConfig): Provider {
  switch (cfg.emailProvider) {
    case "resend":
      if (!cfg.emailApiKey) throw new Error("NOTIFY_EMAIL_API_KEY is required for the resend provider");
      return new ResendProvider(cfg.emailApiKey);
    default:
      return new NoneProvider();
  }
}
