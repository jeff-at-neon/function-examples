# Send email with Resend

Ready-to-run Neon Functions that send email through the official
[Resend](https://resend.com) Node SDK.

**Layout: `separate`.** Each selected operation deploys as its own Neon Function
under its `slug`; there is no aggregate router. `--name` chooses the local
destination folder, while the slugs below are the remote/`neon.ts` function keys.

## Operations

| Operation | Slug | Recommended | Description |
| --- | --- | --- | --- |
| `send-email` | `sendemail` | yes | Send a single transactional email. |
| `send-batch` | `sendbatch` | yes | Send several emails in one API call. |
| `get-email` | `getemail` | yes | Look up a previously sent email by id. |
| `cancel-email` | `cancelemail` | no | Cancel a scheduled email by id. |

At least one operation is always recommended. The recommended set is what the
interactive picker offers first (or preselects in the "customize" multiselect)
and what a non-interactive `neon functions new` scaffolds when no operation
flags are passed. `cancel-email` is left out of the recommended default because
it cancels a scheduled send.

## Environment

| Variable | Description |
| --- | --- |
| `RESEND_API_KEY` | API key from the Resend dashboard. |

`neon functions new` adds this to a single project-root dotenv file (prompted in
a terminal, or written as a blank placeholder otherwise) and ignores it via
`.gitignore` — it is not scaffolded into a per-function `.env.example`.

## Dependencies

- `resend@6.28.0`

## Scaffold it

```bash
neon functions new resend --name sendemail --install
```
