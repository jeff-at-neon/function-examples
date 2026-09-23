# Env form hints for the deploy dialog (`widget` + `type`)

For the console/GUI rendering the deploy form. Every `template.json` `environment[]` entry now
carries two extra fields alongside the existing `name` / `description` / `required` / `injected` /
`secret` / `default` / `example`.

## The fields

- **`type`** — `string` | `int` | `number` | `boolean` | `json`. Use for input coercion and
  pre-deploy validation.
- **`widget`** — the control to render, from a fixed vocabulary:
  | widget | render as |
  |---|---|
  | `text` | plain text input |
  | `secret` | password/masked input, never echo |
  | `number` | numeric input (pairs with `type: int`/`number`) |
  | `json` | JSON editor — the fix for hostile blob vars (`QUEUE_CONCURRENCY`, `ROUTER_ROUTES`) |
  | `bucket` | bucket picker (`*_BUCKET` vars) |
  | `schedule` | cron / schedule builder |

## How the form should use them

For each **non-`injected`** variable: render the control named by `widget`, mark required per
`required`, prefill `default`, use `example` as the placeholder, and validate the value against
`type` before enabling deploy. **`injected`** variables (`DATABASE_URL`, storage/AI-gateway creds)
are shown as "provided by Neon" and never prompted.

Treat an unknown or absent `widget` as `text`.

## How they're derived (confidence level)

These are inferred in the generator from each variable's **name + default**, so they're **hints,
not contracts**:

- `*_BUCKET` → `bucket`
- a `{…}` / `[…]` default → `type: json`, `widget: json`
- a numeric default → `type: int`/`number`, `widget: number`
- credential-shaped names (`*SECRET*` / `*TOKEN*` / `*KEY*` / `*PASSWORD*` / `*CREDENTIAL*`) →
  `secret: true`, `widget: secret`
- everything else → `type: string`, `widget: text`

Good defaults, but if one is wrong (e.g. a comma-list like `IMAGES_ALLOWED_WIDTHS` currently renders
as `text`), flag the variable and we'll add an explicit override in the block manifest.

## Where to read them

In **`template.json`** (the detail / deploy fetch) — not the index. `registry.json` carries only the
card-level fields (`depth`, `billing`, `capabilities`, `functionSlug`, `zip`, `sha256`, `bytes`,
`dependsOn`) so the browse grid renders from one fetch.

Both are live and CORS-open at `https://jeff-at-neon.github.io/function-examples/`, validated against
`schemas/{registry,template}.schema.json`.
