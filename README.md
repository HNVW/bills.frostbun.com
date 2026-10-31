# Shared Bills

Split bills and settle up with friends. One Cloudflare Worker (D1 + R2) serving a static SPA from `public/`.
Installable as a PWA; bills involving you arrive as Web Push notifications.

## Setup

1. Pick the deploy account: the one behind the org `CLOUDFLARE_API_TOKEN` (`Manhnb1911@gmail.com`). It owns the
   `frostbun.com` zone.
2. Create the resources by hand — `bunx wrangler deploy` does not create them, because `wrangler.jsonc` pins both ids/names:

   ```
   bunx wrangler d1 create bills
   bunx wrangler r2 bucket create bills
   ```

   Put the D1 `database_id` into `wrangler.jsonc`, then apply the schema once:

   ```
   bun run db:init
   ```

   (Wrangler can auto-provision resources when a binding omits the id/bucket name, but auto-provisioned D1 bindings
   cannot be used by `d1 execute`/`d1 migrations`, so this project keeps explicit ids.)

   Push notifications additionally need, once per Worker:

   ```
   bunx wrangler secret put VAPID_PUBLIC_KEY
   bunx wrangler secret put VAPID_PRIVATE_KEY
   bunx wrangler secret put VAPID_SUBJECT   # contact URI, e.g. https://bills.frostbun.com
   ```

   `VAPID_SUBJECT` is the `sub` claim of the VAPID JWT (RFC 8292): a contact URI the push service can use to reach the
   operator if this server misbehaves. It is not a notification channel and nothing is emailed to it; `mailto:` and
   `https:` are both valid, an `https:` URL on your own domain being the choice that exposes no address.

   Generate a keypair with `bunx web-push generate-vapid-keys`, or the ECDSA P-256 equivalent. Without the secrets, push
   is skipped and everything else works.
3. Cloudflare Access application for `bills.frostbun.com`, policy = your friends' emails.
   Access injects `Cf-Access-Authenticated-User-Email`; the worker uses it as the user id. No passwords.
   `workers_dev` is off, so that domain is the only entry point.

## Local

```
bun install
bun run db:init:local
echo DEV_EMAIL=you@example.com > .dev.vars
bun run dev
```

`DEV_EMAIL` is the dev-only identity; remove the var to test the real Access headers. `bun run check` typechecks;
`bun run test` exists but the repo has no test files — verification is manual against `wrangler dev`.
Add the VAPID variables to `.dev.vars` to exercise push locally; `wrangler dev --test-scheduled` plus
`GET /__scheduled` runs the orphan sweep on demand.

## Deploy

```
bun run deploy
```

`bun run deploy` is `wrangler deploy` (installed as a dev dependency). GitHub Actions runs the same on push to `master` (installs deps with Bun,
needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the org secrets). Schema changes are not part of the deploy:
apply `migrations/*.sql` yourself.

## Routes

- `GET /` — your groups.
- `GET /<group-id>` — one group (assets fall back to `index.html` via `not_found_handling`).
- `GET /join/<token>` — join screen; posts the token, then redirects to the group.
- Notifications: browser Web Push (VAPID). The nav bell toggles this browser's subscription; adding a bill pushes to
  every involved member except the person who added it. Secrets `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`
  must be set on the Worker (`wrangler secret put`); with them absent, push is silently skipped.
- `/manifest.webmanifest`, `/sw.js`, `/icon-{192,512}.png` — installable PWA. The service worker caches the shell for
  offline navigation only; `/api/*` and `/img/*` bypass it, so data is always live (and never readable offline).
- `/img/<group-id>/<uuid>.<ext>` — images, members of that group only.

Every `/api/*` route requires the Access identity (`401` otherwise). The only difference is that `/api/join/:token`
needs no prior membership — it is how you join.

| Route | Effect |
| --- | --- |
| `GET /api/push/key` | VAPID public key for `pushManager.subscribe` |
| `POST·DELETE /api/push/subscribe` | register / drop this browser's push subscription |
| `GET /api/me` | `{email, name}` |
| `PATCH /api/me` | set display name |
| `GET /api/groups?q=&limit=&offset=` | your groups with `myBalance`, newest activity first (last bill/payment, else creation); `q` matches the name; defaults `limit=5` |
| `POST /api/groups` | create a group |
| `GET /api/groups/:id` | group, members, `inviteToken` |
| `PATCH /api/groups/:id` | rename (member) |
| `DELETE /api/groups/:id` | delete with all data (creator) |
| `POST /api/groups/:id/invite` | rotate invite token (member) |
| `POST /api/groups/:id/members` | invite by email (member) |
| `DELETE /api/groups/:id/members/:email` | leave, or remove others (creator) |
| `GET·POST /api/groups/:id/bills` | list / create bill |
| `PATCH·DELETE /api/groups/:id/bills/:billId` | edit / delete bill |
| `GET·POST /api/groups/:id/payments` | list / create payment |
| `PATCH·DELETE /api/groups/:id/payments/:paymentId` | edit / delete payment |
| `GET /api/groups/:id/summary` | totals, balances, settle-up transfers |
| `POST /api/groups/:id/images` | upload an image |
| `POST /api/join/:token` | join a group |

Limits: group and display names 1–80 and 1–60 chars, bill title 200 chars (truncated), at least one involved member,
10 images per entry, 8 MB per image, `limit` capped at 50. Amounts are positive integers in đồng; the form groups digits with Vietnamese dots (`100.000`) and sends the bare number. Errors are `{error}` with `400` (invalid input),
`401` (no Access identity), `403` (not a member / not the creator), `404`, or `409` (referenced image vanished).

## Data

- `groups(id, name, created_by, invite_token, …)`, `members(group_id, email)`,
  `bills(amount VND integer, paid_by, participants JSON, images JSON)`, `payments(from, to, amount, images)`,
  `users(email, name)`, `uploads(key, group_id, created_at)`, `push_subscriptions(endpoint, email, p256dh, auth)`.
- `users(email, name)` is the display name. Default is the Access identity name, fetched once from
  `/cdn-cgi/access/get-identity` (the app JWT has no name claim) and stored; an email-valued row is re-defaulted on the
  next visit. Override with `PATCH /api/me {"name"}` (the nav button). Email stays the credential.
- Log out is the Access logout endpoint: `/cdn-cgi/access/logout`.
- D1 `bills` runs in APAC (`running_in_region: APAC`). R2 `bills` placement is whatever the account first gave the name
  (the hint is ignored for an existing name).
- Schema lives in `migrations/0001_init.sql`, one idempotent file covering all tables; re-running it is safe. There is
  no migration runner: schema changes are applied by hand (`bun run db:init`), and adding a column means editing this
  file plus running the `ALTER` yourself.
- Invites: each group has an `invite_token`; the members dialog shows `/<host>/join/<token>` plus Copy and Rotate.
  `POST /api/join/:token` adds the signed-in caller and returns the group (idempotent; rotating invalidates the old token).
- Membership is the whole permission model: any member can create, edit and delete any bill or payment in the group;
  only the creator can rename/delete the group or remove other members.
- Images: `POST /api/groups/:id/images` (multipart `file`, ≤8 MB, image/*) returns a key `<group-id>/<uuid>.<ext>`;
  pass keys in `images`. Keys are validated to belong to the group, and saving a bill/payment checks each object still
  exists (`409` otherwise).
- Uploads are tracked in `uploads(key, group_id, created_at)` until referenced; deleting a bill/payment/group deletes
  its objects. A daily cron (`0 0 * * *`, 00:00 UTC) deletes tracked objects older than 1 hour that no bill or payment
  references, so nothing exists in R2 that D1 does not know about.
- One push subscription per user per browser: subscribing replaces that user's previous rows (browsers rotate the
  endpoint on every resubscribe), and endpoints answering `404`/`410` are deleted on the next send.
- Balance display is from the viewer's side: `22.500 ₫` in red (`--attention`) means you must pay that much, `−30.000 ₫`
  in green (`--success`) means you receive it, and |balance| < 1000 ₫ shows `settled`. Only a minus is ever printed —
  positive amounts carry no `+`. The API's `myBalance` keeps the raw payer-credit sign (positive = others owe you), so
  the sign you see is the inverse of the number in JSON.
- Bill cards: green border (`--success`) when you paid, red border (`--attention`) when you are involved but did not
  pay, plain otherwise. Details (names, images, payer) live in the card's Details dialog, and the card shows the
  participant count.
- Summary: each bill adds `amount` to the payer and subtracts the even split (leftover đồng to the first participants)
  from each participant; payments shift balances; greedy min-cash-flow produces the transfer list.
