# Block 13 — Notifications

Send email, SMS, and push with templates, preferences, and quiet hours

**Block 13 of 25**, numbered in build order.

> **Status: implemented.** Schema, safety checks, control flow, and the core logic (quiet-hours
> deferral, channel-aware template rendering, and digest collapsing behind a provider adapter) are
> all wired, with pure unit tests. Live email send goes through a provider (Resend) adapter. Still
> unverified against a live Neon project.

## Why this block

Every app sends notifications and every app rebuilds preferences, quiet hours, and dedupe. The part that actually matters is restraint: the difference between a product people keep notifications on for and one they mute is entirely in the suppression logic, not the sending.

## Install

```bash
neon-blocks migrate notifications
neon function deploy notifications --src blocks/notifications/src
neon triggers create --function-slug notifications --name notifications-send \
  --schedule '* * * * *' --function-path '/send'
neon triggers create --function-slug notifications --name notifications-digest \
  --schedule '19 8 * * *' --function-path '/digest'
```

> Child branches inherit triggers **disabled**. Enable them after promoting, or scheduled work
> silently never runs.

## Design notes

- **Preferences are per (user, channel, category).** A single on/off switch means users mute everything to stop one noisy category. Granularity is what keeps notifications enabled.
- **Quiet hours defer, never drop.** A notification suppressed at 2am is sent at 8am. Dropping it silently is how users miss things that mattered, and it's indistinguishable from a bug.
- **Dedupe on a caller-supplied key within a window.** Three password-reset requests in a minute should produce one email, and the queue's at-least-once delivery makes this mandatory rather than nice.
- **Digest rollups collapse N notifications into one.** Ten comments on a thread is one email, not ten — and the digest window is per category, since a security alert should never be digested.
- **Providers sit behind one interface** (`providers/`). Resend *or* SES, Twilio *or* SNS. A block that only works with one vendor's key is not reusable.

## API

| Route | Purpose |
|---|---|
| `POST /notify` | Enqueue a notification, applying preferences and quiet hours. |
| `POST /send` | Cron. Send due and released notifications. |
| `POST /digest` | Cron. Roll up digested notifications. |
| `GET /preferences` | A user's preferences. |
| `GET /health` | `200` / `503`. |

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `NOTIFY_EMAIL_PROVIDER` | `none` | Adapter to use: resend, ses, or none. |
| `NOTIFY_EMAIL_FROM` | `` | Default From address. |
| `NOTIFY_SMS_PROVIDER` | `none` | Adapter to use: twilio, sns, or none. |
| `NOTIFY_DEDUPE_WINDOW_MINUTES` | `60` | Window in which an identical dedupe key is suppressed. |
| `NOTIFY_QUIET_HOURS_DEFAULT` | `22:00-08:00` | Default quiet window as HH:MM-HH:MM in the user's timezone. Empty disables. |
| `NOTIFY_BATCH_SIZE` | `50` | Notifications sent per invocation. |
| `NEON_BLOCKS_TRIGGER_SECRET` | `` | Shared secret authenticating trigger delivery. Neon does not sign trigger POSTs. |

Injected automatically by Neon: `DATABASE_URL`.

## Limits and honest caveats

- **Provider adapters are TODO seams.** The interface and the dispatch logic are specified; the HTTP calls to Resend/SES/Twilio are not written. This is deliberate — the value is in preferences and suppression, not in wrapping a send API.
- **Template rendering is not implemented.** The schema holds templates and a variables jsonb; interpolation needs a real engine with escaping. Naive `replace()` on user data is an injection vector in HTML email.
- **Timezone handling for quiet hours requires a per-user timezone**, stored but unused until rendering lands. Cron is UTC-only, so a user's 8am is computed at send time, not scheduled.
- **No unsubscribe link generation or bounce handling.** Both are legally significant for bulk email and deliberately out of scope for a transactional block.
- **Unverified against a live Neon project.** Nothing in this repo has been run against real Neon
  infrastructure yet.

## Observability

```sql
SELECT * FROM blocks_notifications.v_status;
```

## Uninstall

```bash
neon-blocks rollback notifications
```
