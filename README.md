# Shared Bills

Split bills and settle up with friends. One Cloudflare Worker (D1 + R2) serving a static SPA from `public/`.
Installable as a PWA; bills involving you arrive as Web Push notifications.

The UI is Vietnamese by default with an English switch, and ships eight colour schemes — four light (paper, newsprint,
moss, porcelain) and four dark (midnight, ink, plum, forest) — chosen in the settings dialog (gear in the nav, or `?`).
Both live in `localStorage` and are applied by a four-line inline script before first paint, so neither flashes.
Copy lives in `public/i18n.js` (flat dotted keys, `{param}` interpolation); a missing Vietnamese key falls back to
English rather than showing a raw key. Fonts are self-hosted (`public/fonts/`, Public Sans variable, latin + vietnamese
subsets) so a slow CDN never swaps the face mid-render.

## Setup

`wrangler.jsonc` holds the only account-specific values: the D1 `database_id` and the `routes` pattern. Nothing else
ties the app to one account, so porting means editing those two fields; the Worker code contains no hostname or
account id.

1. Set `routes[0].pattern` to a hostname in the deploying account's zone. To deploy without a custom domain, delete
   `routes` and set `workers_dev: true`; put the Access application on the `*.workers.dev` hostname instead.
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
   is skipped and everything else works. `VAPID_SUBJECT` has no default: unset, the Worker logs
   `push skipped: VAPID_SUBJECT is not set` and sends nothing.
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
`bun run test` covers the money split (`src/split.test.ts`); everything else is verified by hand against `wrangler dev`.
Add the VAPID variables to `.dev.vars` to exercise push locally.

## Deploy

```
bun run deploy
```

`bun run deploy` is `wrangler deploy` (installed as a dev dependency). GitHub Actions runs the same on push to `master` (installs deps with Bun,
needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the org secrets).

## Routes

- `GET /` — your groups.
- `GET /<group-id>` — one group (assets fall back to `index.html` via `not_found_handling`).
- `GET /join/<token>` — join screen; posts the token, then redirects to the group.
- Notifications: browser Web Push (VAPID). The nav bell toggles this browser's subscription; adding a bill pushes to
  every involved member except the person who added it. Secrets `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`
  must be set on the Worker (`wrangler secret put`); with them absent, push is silently skipped.
- `/manifest.webmanifest`, `/sw.js`, `/icon-{192,512}.png` — installable PWA. The service worker precaches exactly
  those three files and serves them cache-first, which is an installability requirement rather than an offline
  nicety: Chrome fetches a manifest link without credentials, so behind Cloudflare Access the request is answered
  with a 302 to the login origin, and Chrome refuses to parse a cross-origin manifest — the installer then reports
  "No manifest detected". The precache fetch runs inside the worker, so it carries the session cookie and succeeds.
  Bump `CACHE` in `sw.js` when the manifest or icons change; on activate the worker deletes other `bills-*` caches.
- The service worker does **not** cache the app: every screen needs `/api/*`, so a cached shell could only render an
  empty page. Its other fetch job is a failed navigation, which gets a self-contained "no connection" page carried as a
  string in `sw.js`. Push notifications are unaffected.
- `/img/<key>` — an entry image or a person's QR, readable by group members (QR: anyone sharing a group).

Every `/api/*` route requires the Access identity (`401` otherwise). The only difference is that `/api/join/:token`
needs no prior membership — it is how you join.

| Route | Effect |
| --- | --- |
| `GET /api/push/key` | VAPID public key for `pushManager.subscribe` |
| `POST·DELETE /api/push/subscribe` | register / drop this browser's push subscription |
| `GET /api/groups?q=&limit=&offset=` | your groups with `myBalance`, newest activity first (last bill/payment, else creation); `q` matches the name; defaults `limit=5` |
| `POST /api/groups` | create a group |
| `GET /api/groups/:id` | group, members, `inviteToken` |
| `GET /api/groups/:id/view` | the group screen in one round trip: group, `inviteToken`, members, bills, payments, summary |
| `PATCH /api/groups/:id` | rename (any member) |
| `DELETE /api/groups/:id` | delete with all data (creator) |
| `POST /api/groups/:id/invite` | rotate invite token (member) |
| `POST /api/groups/:id/members` | invite by email (member) |
| `DELETE /api/groups/:id/members/:email` | leave, or remove others (creator) |
| `GET·POST /api/groups/:id/bills` | list / create bill |
| `PATCH·DELETE /api/groups/:id/bills/:billId` | edit / delete bill |
| `GET·POST /api/groups/:id/payments` | list / create payment |
| `PATCH·DELETE /api/groups/:id/payments/:paymentId` | edit / delete payment |
| `GET /api/groups/:id/summary` | totals, balances, settle-up transfers |
| `POST /api/groups/:id/bills/:billId/image` | upload this bill's image (one per bill) |
| `POST /api/groups/:id/payments/:paymentId/image` | upload this payment's image (one per payment) |
| `GET·PATCH /api/me` | `{email, name, qr}`; PATCH sets the display name (`qr` is a URL or `null`) |
| `POST·DELETE /api/me/qr` | upload / remove your payment QR (multipart `file`) |
| `POST /api/join/:token` | join a group |

Limits: group and display names 1–80 and 1–60 chars, bill title 200 chars (truncated), at least one involved member,
one image per entry, 8 MB per image, `limit` capped at 50. Amounts are positive integers in đồng; the form groups
digits per locale (`100.000` in vi, `100,000` in en) and sends the bare number. A bill carries `weights`, an object of
participant email to weight (above 0, at most 100): a person of weight 2 pays twice the share of weight 1. Its keys
*are* the participants, in split order — there is no separate list to keep in sync. An absent map means the payer
alone at weight 1. Errors are `{error}` with `400` (invalid input),
`401` (no Access identity), `403` (not a member / not the creator), `404`, or `409` (entry id already used, referenced
image vanished).

## Data

- `groups(id, name, created_by, invite_token, created_at)`, `members(group_id, email, created_at)`,
  `bills(amount VND integer, paid_by, weights JSON, image)`, `payments(from, to, amount, image)`,
  `users(email, name, qr)`, `push_subscriptions(endpoint, email, p256dh, auth)`.
- `users(email, name)` is the display name, `users.qr` the optional payment-QR key. Default is the Access identity name, fetched once from
  `/cdn-cgi/access/get-identity` (the app JWT has no name claim) and stored; an email-valued row is re-defaulted on the
  next visit. Override with `PATCH /api/me {"name"}` (the nav button). Email stays the credential.
- Log out is the Access logout endpoint: `/cdn-cgi/access/logout`.
- R2 `bills` placement is whatever the account first gave the name (the placement hint is ignored for an existing name).
- Schema lives in `migrations/0001_init.sql`, one idempotent file covering all tables; re-running it is safe.
- Invites: each group has an `invite_token`; the members dialog shows `/<host>/join/<token>` plus Copy and Rotate.
  `POST /api/join/:token` adds the signed-in caller and returns the group (idempotent; rotating invalidates the old token).
- Membership is the whole permission model: any member can create, edit and delete any bill or payment, rename the
  group, invite or remove members (each row in the members dialog has a Remove button), and delete the whole group. There is no owner role — `created_by` is recorded for
  provenance only. The app is built for a trusted group of friends; the boundary is membership, not authorship.
- R2 layout: `qrs/<email>`, `bills/<group-id>/<bill-id>`, `payments/<group-id>/<payment-id>`. One object per entry at
  a key derived entirely from the entry (`entryKey`, `qrKey`) — no extra random component, no extension.
- Image upload: `POST /api/groups/:id/bills/:billId/image` (or `.../payments/:paymentId/image`), multipart `file`,
  ≤8 MB, image/*. The Worker owns the key, so the client cannot name an object; it sends the returned key back as
  `image` and the Worker stores it only if it matches the derived key. Ids are minted client-side so the image can be
  uploaded before the row exists; `POST` rejects a reused id with `409`.
- Keys carry no extension, so `serveImage` serves R2's stored `httpMetadata.contentType`. Uploads made through the
  app always set it; anything written to the bucket by another tool must set it too.
- Keys must start at the bucket root: the Worker serves `/img/<key>` where `<key>` is exactly `bills/<group>/<entry>`,
  `payments/<group>/<entry>` or `qrs/<email>`. A key under any extra prefix reads as a 404.
- No orphan sweep: there is no `uploads` table and no cron. An entry's object is deleted by exact key on edit/delete.
  Group deletion lists by prefix (`deletePrefix`) so images uploaded for never-saved entries are removed too.
- Keys written before the layout split (`<group-id>/<uuid>.<ext>`) are still served (`LEGACY_RE`).
- Personal QR: `POST /api/me/qr` stores the key in `users.qr` (`qrs/<email>`) and the object in R2; `DELETE` clears
  both. Readable by you and by anyone sharing a group with you (`canSeeQr`), served at `/img/qrs/<email>`. Clicking a
  name in a group's summary opens it; the nav name opens a dialog to edit your display name and replace/remove the QR.
- One push subscription row per browser: a row is identified by its endpoint, so enabling notifications in a
  second browser adds a second row instead of replacing the first. Re-enabling in the same browser reuses its row
  (browsers rotate the endpoint on resubscribe, which lands as a new row — the stale one is deleted on the next
  send that answers `404`/`410`).
- Balance display is from the viewer's side and never uses a sign: the words "you pay" / "you get back" (vi: "bạn trả" /
  "bạn nhận lại") sit beside an unsigned amount, coloured `--owe` / `--owed`, and |balance| < 1000 ₫ shows `settled`. The
  API's `myBalance` keeps the raw payer-credit sign (positive = others owe you), so the direction you see is the inverse
  of the JSON number.
- Bill cards: a 2px left edge in `--owed` when you paid, `--owe` when you are involved but did not pay, plain otherwise.
  Details (names, images, payer, per-person weights) live in the card's Details dialog; the card shows the participant
  count.
- Summary: each bill adds `amount` to the payer and subtracts that person's weighted share (leftover đồng go one each to
  the heaviest weights, then declaration order, so the shares sum to the amount) from each participant; payments shift
  balances; greedy min-cash-flow produces the transfer list.
- Weights: the bill form shows a number field per member beside its checkbox, disabled when the member is unchecked.
  `bills.weights` is the only stored list of involved people; `participants` in the API response is derived from its
  keys, so a bill with no participants and a bill with an empty weights map are the same rejected state.
