export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  DEV_EMAIL?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

import { buildPushPayload } from "@block65/webcrypto-web-push";

type Handler = (c: Ctx) => Promise<Response>;
type Ctx = { req: Request; env: Env; url: URL; email: string; p: string[]; ctx: ExecutionContext };

const json = (data: unknown, status = 200) => Response.json(data, { status });
const error = (message: string, status = 400) => json({ error: message }, status);

const normEmail = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");
const parse = <T,>(s: string, fallback: T): T => {
  try {
    return (JSON.parse(s) as T) ?? fallback;
  } catch {
    return fallback;
  }
};

// VND has no subunit; splits distribute the leftover đồng to the first participants.
function split(amount: number, participants: string[]) {
  const base = Math.floor(amount / participants.length);
  const rem = amount - base * participants.length;
  return participants.map((p, i) => [p, base + (i < rem ? 1 : 0)] as const);
}

const routes: { method: string; re: RegExp; fn: Handler }[] = [];
function on(method: string, path: string, fn: Handler) {
  routes.push({ method, re: new RegExp(`^${path.replace(/:\w+/g, "([^/]+)")}$`), fn });
}

function jwtClaims(req: Request): Record<string, unknown> {
  const jwt = req.headers.get("cf-access-jwt-assertion");
  if (!jwt) return {};
  try {
    const payload = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(payload + "=".repeat((4 - (payload.length % 4)) % 4)));
  } catch {
    return {};
  }
}

// The app token has no display name; the full identity does.
async function identityName(req: Request): Promise<string> {
  const iss = jwtClaims(req).iss;
  const cookie = req.headers.get("cookie");
  const token = cookie && /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie)?.[1];
  if (typeof iss !== "string" || !iss.startsWith("https://") || !token) return "";
  try {
    const res = await fetch(`${iss}/cdn-cgi/access/get-identity`, { headers: { cookie: `CF_Authorization=${token}` } });
    if (!res.ok) return "";
    const name = (await res.json() as { name?: unknown }).name;
    return typeof name === "string" ? name.trim().slice(0, 60) : "";
  } catch {
    return "";
  }
}

async function isMember(env: Env, groupId: string, email: string) {
  const row = await env.DB.prepare("SELECT 1 AS ok FROM members WHERE group_id = ? AND email = ?")
    .bind(groupId, email)
    .first();
  return !!row;
}

async function membersOf(env: Env, groupId: string) {
  const { results } = await env.DB.prepare(
    `SELECT m.email, COALESCE(u.name, m.email) AS name, u.qr AS qr
     FROM members m LEFT JOIN users u ON u.email = m.email
     WHERE m.group_id = ? ORDER BY m.created_at, m.email`,
  )
    .bind(groupId)
    .all<{ email: string; name: string; qr: string | null }>();
  return results.map((m) => ({ ...m, qr: qrUrl(m.qr) }));
}

// R2 layout: `qrs/<email>`, `<kind>/<group-id>/<entry-id>`. Every key is produced here and nowhere else.
const qrKey = (email: string) => `qrs/${email}`;
const qrUrl = (key: string | null) => (key ? `/img/${key}` : null);
// One object per entry, at a key derived from the entry: no listing, no bookkeeping, nothing to sweep.
const entryKey = (kind: "bills" | "payments", groupId: string, entryId: string) => `${kind}/${groupId}/${entryId}`;

// `<kind>/<id>/<uuid>.<ext>` for bills and payments; `qrs/<email>` for a person's payment QR.
// Keys written before the layout split (`<group-id>/<uuid>.<ext>`) are still served; nothing was migrated.
const LEGACY_RE = /^([0-9a-f-]{36})\/[A-Za-z0-9-]+\.[a-z0-9]{1,8}$/;

async function deleteImages(env: Env, keys: string[]) {
  await Promise.all(keys.map((k) => env.IMAGES.delete(k).catch(() => undefined)));
}

// Uploading for an entry id before saving leaves an object behind if the form is abandoned, so a group
// delete sweeps by prefix rather than trusting D1. Nothing schedules this; deletion is the only leak path.
async function deletePrefix(env: Env, prefix: string) {
  for (;;) {
    const { objects } = await env.IMAGES.list({ prefix, limit: 1000 });
    if (!objects.length) return;
    await deleteImages(env, objects.map((o) => o.key));
    if (objects.length < 1000) return;
  }
}

async function displayName(env: Env, email: string) {
  const row = await env.DB.prepare("SELECT name FROM users WHERE email = ?").bind(email).first<{ name: string }>();
  return row?.name ?? email;
}

async function notifyBillCreated(env: Env, groupId: string, actor: string, bill: { title: string; amount: number; participants: string[] }) {
  const targets = bill.participants.filter((p) => p !== actor);
  if (!targets.length) return;
  const group = await env.DB.prepare("SELECT name FROM groups WHERE id = ?").bind(groupId).first<{ name: string }>();
  const who = await displayName(env, actor);
  const amount = bill.amount.toLocaleString("vi-VN") + " ₫";
  const title = bill.title ? `${bill.title} · ${amount}` : amount;
  await sendPush(env, targets, `${who} added a bill in ${group?.name ?? "a group"}`, `${title} — you are involved`, `/${groupId}`);
}

async function sendPush(env: Env, to: string[], title: string, body: string, url: string) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !to.length) return;
  const { results } = await env.DB.prepare(
    `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE email IN (${to.map(() => "?").join(",")})`,
  )
    .bind(...to)
    .all<{ endpoint: string; p256dh: string; auth: string }>();
  // `sub` is a contact URI for the push service, not a delivery address. Required per RFC 8292: a
  // missing subject silently disables push rather than borrowing some other deployment's identity.
  if (!env.VAPID_SUBJECT) {
    console.log("push skipped: VAPID_SUBJECT is not set");
    return;
  }
  const vapid = { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  await Promise.all(
    results.map(async (r) => {
      const sub = { endpoint: r.endpoint, expirationTime: null, keys: { p256dh: r.p256dh, auth: r.auth } };
      // the library rejects non-https; loopback is allowed only for local testing
      const endpoint = env.DEV_EMAIL ? sub.endpoint.replace(/^http:\/\//, "https://") : sub.endpoint;
      const payload = await buildPushPayload({ data: JSON.stringify({ title, body, url }), options: { ttl: 3600 } }, { ...sub, endpoint }, vapid).catch((e) => {
        console.log("push payload failed", String(e));
        return null;
      });
      if (!payload) return;
      const res = await fetch(r.endpoint, payload).catch((e) => {
        console.log("push failed", r.endpoint.slice(0, 40), String(e));
        return null;
      });
      // 404/410 mean the browser dropped the subscription
      if (res && (res.status === 404 || res.status === 410)) {
        await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(r.endpoint).run();
      }
    }),
  );
}

// The viewer's net position in each group: paid minus their share, adjusted by payments.
async function balancesOf(env: Env, groupIds: string[], email: string) {
  const out = new Map<string, number>(groupIds.map((g) => [g, 0]));
  if (!groupIds.length) return out;
  const ph = groupIds.map(() => "?").join(",");
  const { results: bills } = await env.DB.prepare(
    `SELECT group_id, amount, paid_by, participants FROM bills WHERE group_id IN (${ph})`,
  )
    .bind(...groupIds)
    .all<{ group_id: string; amount: number; paid_by: string; participants: string }>();
  const { results: pays } = await env.DB.prepare(
    `SELECT group_id, amount, from_email, to_email FROM payments WHERE group_id IN (${ph})`,
  )
    .bind(...groupIds)
    .all<{ group_id: string; amount: number; from_email: string; to_email: string }>();

  for (const b of bills) {
    if (b.paid_by === email) out.set(b.group_id, (out.get(b.group_id) ?? 0) + b.amount);
    const participants = parse(b.participants, []);
    const mine = participants.length ? split(b.amount, participants).find(([p]) => p === email) : undefined;
    if (mine) out.set(b.group_id, (out.get(b.group_id) ?? 0) - mine[1]);
  }
  for (const p of pays) {
    if (p.from_email === email) out.set(p.group_id, (out.get(p.group_id) ?? 0) + p.amount);
    if (p.to_email === email) out.set(p.group_id, (out.get(p.group_id) ?? 0) - p.amount);
  }
  return out;
}

const groupOut = (g: Record<string, unknown>) => ({
  id: g.id,
  name: g.name,
  createdBy: g.created_by,
  createdAt: g.created_at,
  ...(g.member_count !== undefined ? { memberCount: g.member_count } : {}),
});

const billOut = (b: Record<string, unknown>) => ({
  id: b.id,
  groupId: b.group_id,
  title: b.title,
  amount: b.amount,
  paidBy: b.paid_by,
  participants: parse(b.participants as string, []),
  image: b.image ?? null,
  createdBy: b.created_by,
  createdAt: b.created_at,
});

const paymentOut = (p: Record<string, unknown>) => ({
  id: p.id,
  groupId: p.group_id,
  from: p.from_email,
  to: p.to_email,
  amount: p.amount,
  image: p.image ?? null,
  createdBy: p.created_by,
  createdAt: p.created_at,
});

function parseAmount(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
}

function parseParticipants(v: unknown, allowed: Set<string>, fallback: string): string[] | string {
  if (v !== undefined && v !== null && !Array.isArray(v)) return "participants must be an array";
  const raw = Array.isArray(v) && v.length ? v : [fallback];
  const out = [...new Set(raw.map(normEmail).filter(Boolean))];
  if (!out.length) return "participants required";
  for (const p of out) if (!allowed.has(p)) return `not a member of this group: ${p}`;
  return out;
}

const asId = (v: unknown) => (typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : "");

// The key is derived from the entry id, so the client never names an object and there is nothing to validate.
// A client-sent `image` is compared against the derived key: any other value is dropped, never stored.
function pickImage(v: unknown, expected: string): string | null {
  return v === expected ? expected : null;
}

async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  const b = await req.json().catch(() => null);
  return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
}

// --- groups ---

on("POST", "/api/join/:token", async ({ env, email, p }) => {
  const [token] = p;
  const g = await env.DB.prepare("SELECT id, name FROM groups WHERE invite_token = ?")
    .bind(token)
    .first<{ id: string; name: string }>();
  if (!g) return error("invite link is invalid or was rotated", 404);
  await env.DB.prepare("INSERT OR IGNORE INTO members (group_id, email, created_at) VALUES (?, ?, ?)")
    .bind(g.id, email, new Date().toISOString())
    .run();
  return json({ id: g.id, name: g.name, joined: true });
});

// The Access name is a default: stored once, PATCH /api/me overrides it, and an email-valued row is re-defaulted.
async function ensureUserName(env: Env, req: Request, email: string) {
  const existing = await env.DB.prepare("SELECT name FROM users WHERE email = ?").bind(email).first<{ name: string }>();
  if (existing && existing.name !== email) return;
  const name = (await identityName(req)) || email;
  await env.DB.prepare(
    "INSERT INTO users (email, name) VALUES (?, ?) ON CONFLICT (email) DO UPDATE SET name = excluded.name WHERE users.name = users.email",
  )
    .bind(email, name)
    .run();
}

on("GET", "/api/push/key", async ({ env }) => json({ publicKey: env.VAPID_PUBLIC_KEY ?? "" }));

on("POST", "/api/push/subscribe", async ({ req, env, email }) => {
  const b = await jsonBody(req);
  const endpoint = typeof b.endpoint === "string" ? b.endpoint : "";
  const keys = (b.keys ?? {}) as Record<string, unknown>;
  const p256dh = typeof keys.p256dh === "string" ? keys.p256dh : "";
  const auth = typeof keys.auth === "string" ? keys.auth : "";
  const local = env.DEV_EMAIL && /^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(endpoint);
  if ((!endpoint.startsWith("https://") && !local) || !p256dh || !auth) return error("invalid subscription");
  // The endpoint identifies the browser: a rotated endpoint arrives as a new row, and the old one is
  // dropped later by the 404/410 sweep. Rows for other browsers stay — they are separate devices.
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, email, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET email = excluded.email, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at`,
  )
    .bind(endpoint, email, p256dh, auth, new Date().toISOString())
    .run();
  return json({ ok: true }, 201);
});

on("DELETE", "/api/push/subscribe", async ({ req, env, email }) => {
  const raw = (await jsonBody(req)).endpoint;
  if (typeof raw !== "string" || !raw) return error("endpoint required");
  const { meta } = await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND email = ?")
    .bind(raw, email)
    .run();
  return json({ deleted: meta.changes });
});

on("GET", "/api/me", async ({ req, env, email }) => {
  await ensureUserName(env, req, email);
  const row = await env.DB.prepare("SELECT name, qr FROM users WHERE email = ?")
    .bind(email)
    .first<{ name: string; qr: string | null }>();
  return json({ email, name: row?.name ?? email, qr: qrUrl(row?.qr ?? null) });
});

on("PATCH", "/api/me", async ({ req, env, email }) => {
  const body = await jsonBody(req);
  if (body.name === undefined) return error("name required (1-60 chars)");
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 60) return error("name required (1-60 chars)");
  await env.DB.prepare("INSERT INTO users (email, name) VALUES (?, ?) ON CONFLICT (email) DO UPDATE SET name = excluded.name")
    .bind(email, name)
    .run();
  const row = await env.DB.prepare("SELECT qr FROM users WHERE email = ?").bind(email).first<{ qr: string | null }>();
  return json({ email, name, qr: qrUrl(row?.qr ?? null) });
});

// "Recently updated" = last bill or payment, falling back to creation.
const RECENTLY_UPDATED = `COALESCE(
  (SELECT MAX(created_at) FROM bills b WHERE b.group_id = g.id),
  (SELECT MAX(created_at) FROM payments p WHERE p.group_id = g.id),
  g.created_at)`;

on("GET", "/api/groups", async ({ env, email, url }) => {
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 5, 1), 50);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
  const filter = `EXISTS (SELECT 1 FROM members m WHERE m.group_id = g.id AND m.email = ?)${q ? " AND g.name LIKE ?" : ""}`;
  const args = q ? [email, `%${q}%`] : [email];

  const total = await env.DB.prepare(`SELECT COUNT(*) AS c FROM groups g WHERE ${filter}`)
    .bind(...args)
    .first<{ c: number }>();
  const { results } = await env.DB.prepare(
    `SELECT g.*, (SELECT COUNT(*) FROM members x WHERE x.group_id = g.id) AS member_count,
            ${RECENTLY_UPDATED} AS updated_at
     FROM groups g
     WHERE ${filter}
     ORDER BY updated_at DESC, g.created_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(...args, limit, offset)
    .all<Record<string, unknown>>();
  const balances = await balancesOf(env, results.map((g) => g.id as string), email);
  return json({
    groups: results.map((g) => ({ ...groupOut(g), updatedAt: g.updated_at, myBalance: balances.get(g.id as string) ?? 0 })),
    total: total?.c ?? 0,
    limit,
    offset,
  });
});

on("POST", "/api/groups", async ({ req, env, email }) => {
  const body = await jsonBody(req);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 80) return error("name required (1-80 chars)");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO groups (id, name, created_by, created_at, invite_token) VALUES (?, ?, ?, ?, ?)").bind(id, name, email, now, crypto.randomUUID()),
    env.DB.prepare("INSERT INTO members (group_id, email, created_at) VALUES (?, ?, ?)").bind(id, email, now),
  ]);
  return json({ id, name, createdBy: email, createdAt: now, memberCount: 1 }, 201);
});

on("GET", "/api/groups/:id", async ({ req, env, email, p }) => {
  const [id] = p;
  if (!(await isMember(env, id, email))) return error("forbidden", 403);
  await ensureUserName(env, req, email);
  const g = await env.DB.prepare("SELECT * FROM groups WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (!g) return error("not found", 404);
  return json({ ...groupOut(g), inviteToken: g.invite_token, members: await membersOf(env, id), me: email });
});

on("PATCH", "/api/groups/:id", async ({ req, env, email, p }) => {
  const [id] = p;
  if (!(await isMember(env, id, email))) return error("forbidden", 403);
  const body = await jsonBody(req);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 80) return error("name required (1-80 chars)");
  await env.DB.prepare("UPDATE groups SET name = ? WHERE id = ?").bind(name, id).run();
  return json({ id, name });
});

on("DELETE", "/api/groups/:id", async ({ env, email, p }) => {
  const [id] = p;
  const g = await env.DB.prepare("SELECT created_by FROM groups WHERE id = ?").bind(id).first<{ created_by: string }>();
  if (!g) return error("not found", 404);
  if (g.created_by !== email) return error("only the group creator can delete it", 403);
  await removeGroupData(env, id);
  return json({ ok: true });
});

async function removeGroupData(env: Env, id: string) {
  // Prefixes, not ids: this also removes images uploaded for entries that were never saved.
  await Promise.all([deletePrefix(env, `bills/${id}/`), deletePrefix(env, `payments/${id}/`), deletePrefix(env, `${id}/`)]);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM bills WHERE group_id = ?").bind(id),
    env.DB.prepare("DELETE FROM payments WHERE group_id = ?").bind(id),
    env.DB.prepare("DELETE FROM members WHERE group_id = ?").bind(id),
    env.DB.prepare("DELETE FROM groups WHERE id = ?").bind(id),
  ]);
}

on("POST", "/api/groups/:id/invite", async ({ env, email, p }) => {
  const [id] = p;
  if (!(await isMember(env, id, email))) return error("forbidden", 403);
  const token = crypto.randomUUID();
  await env.DB.prepare("UPDATE groups SET invite_token = ? WHERE id = ?").bind(token, id).run();
  return json({ inviteToken: token });
});

on("POST", "/api/groups/:id/members", async ({ req, env, email, p }) => {
  const [id] = p;
  if (!(await isMember(env, id, email))) return error("forbidden", 403);
  const invited = normEmail((await jsonBody(req)).email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(invited)) return error("valid email required");
  await env.DB.prepare("INSERT OR IGNORE INTO members (group_id, email, created_at) VALUES (?, ?, ?)")
    .bind(id, invited, new Date().toISOString())
    .run();
  return json({ members: await membersOf(env, id) }, 201);
});

on("DELETE", "/api/groups/:id/members/:member", async ({ env, email, p }) => {
  const [id, raw] = p;
  const target = normEmail(decodeURIComponent(raw));
  const g = await env.DB.prepare("SELECT created_by FROM groups WHERE id = ?").bind(id).first<{ created_by: string }>();
  if (!g) return error("not found", 404);
  const caller = await isMember(env, id, email) ? email : "";
  if (!caller) return error("forbidden", 403);
  if (target !== caller && g.created_by !== caller) return error("only the creator can remove others", 403);
  await env.DB.prepare("DELETE FROM members WHERE group_id = ? AND email = ?").bind(id, target).run();
  if (!(await membersOf(env, id)).length) await removeGroupData(env, id);
  return json({ ok: true });
});

// --- bills ---

on("GET", "/api/groups/:id/bills", async ({ env, email, p }) => {
  const [id] = p;
  if (!(await isMember(env, id, email))) return error("forbidden", 403);
  const { results } = await env.DB.prepare("SELECT * FROM bills WHERE group_id = ? ORDER BY created_at DESC, rowid DESC")
    .bind(id)
    .all<Record<string, unknown>>();
  return json(results.map(billOut));
});

on("POST", "/api/groups/:id/bills", async ({ req, env, email, p, ctx }) => {
  const [id] = p;
  if (!(await isMember(env, id, email))) return error("forbidden", 403);
  const body = await jsonBody(req);
  const amount = parseAmount(body.amount);
  if (!amount) return error("amount must be a positive integer (VND)");
  const allowed = new Set((await membersOf(env, id)).map((m) => m.email));
  const paidBy = normEmail(body.paidBy) || email;
  if (!allowed.has(paidBy)) return error("paidBy must be a member of this group");
  const participants = parseParticipants(body.participants, allowed, paidBy);
  if (typeof participants === "string") return error(participants);
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
  // The client mints the id so it can upload the image before the row exists; reject a live id instead of
  // silently adopting someone else's bill.
  const billId = body.id === undefined ? crypto.randomUUID() : asId(body.id);
  if (!billId) return error("id must be a UUID");
  if (await env.DB.prepare("SELECT 1 AS ok FROM bills WHERE id = ?").bind(billId).first()) return error("id already used", 409);
  const bill = {
    id: billId,
    title,
    amount,
    paidBy,
    participants,
    createdAt: new Date().toISOString(),
    createdBy: email,
  };
  const image = pickImage(body.image, entryKey("bills", id, bill.id));
  if (image && !(await env.IMAGES.head(image))) return error("image no longer exists", 409);
  await env.DB.prepare(
    "INSERT INTO bills (id, group_id, title, amount, paid_by, participants, image, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(bill.id, id, bill.title, bill.amount, bill.paidBy, JSON.stringify(participants), image, email, bill.createdAt)
    .run();
  ctx.waitUntil(notifyBillCreated(env, id, email, bill).catch(() => undefined));
  return json({ ...bill, image }, 201);
});

on("PATCH", "/api/groups/:id/bills/:bill", async ({ req, env, email, p }) => {
  const [id, billId] = p;
  if (!(await isMember(env, id, email))) return error("forbidden", 403);
  const row = await env.DB.prepare("SELECT * FROM bills WHERE id = ? AND group_id = ?")
    .bind(billId, id)
    .first<Record<string, unknown>>();
  if (!row) return error("not found", 404);
  const body = await jsonBody(req);
  const current = billOut(row);
  const amount = body.amount === undefined ? current.amount : parseAmount(body.amount);
  if (!amount) return error("amount must be a positive integer (VND)");
  const allowed = new Set((await membersOf(env, id)).map((m) => m.email));
  const paidBy = body.paidBy === undefined ? current.paidBy : normEmail(body.paidBy);
  if (!allowed.has(paidBy as string)) return error("paidBy must be a member of this group");
  const participants = parseParticipants(body.participants ?? current.participants, allowed, paidBy as string);
  if (typeof participants === "string") return error(participants);
  const title = body.title === undefined ? current.title : typeof body.title === "string" ? body.title.trim().slice(0, 200) : current.title;
  const before = (current.image as string | null) ?? null;
  const image = body.image === undefined ? before : pickImage(body.image, entryKey("bills", id, billId));
  if (image && image !== before && !(await env.IMAGES.head(image))) return error("image no longer exists", 409);
  await env.DB.prepare("UPDATE bills SET title = ?, amount = ?, paid_by = ?, participants = ?, image = ? WHERE id = ? AND group_id = ?")
    .bind(title, amount, paidBy, JSON.stringify(participants), image, billId, id)
    .run();
  if (before && before !== image) await deleteImages(env, [before]);
  return json({ ...current, title, amount, paidBy, participants, image });
});

on("DELETE", "/api/groups/:id/bills/:bill", async ({ env, email, p }) => {
  const [id, billId] = p;
  if (!(await isMember(env, id, email))) return error("forbidden", 403);
  const row = await env.DB.prepare("SELECT image FROM bills WHERE id = ? AND group_id = ?")
    .bind(billId, id)
    .first<{ image: string | null }>();
  if (!row) return error("not found", 404);
  await env.DB.prepare("DELETE FROM bills WHERE id = ? AND group_id = ?").bind(billId, id).run();
  // An entry's object lives at its derived key; a legacy row may still point elsewhere, so delete both.
  await deleteImages(env, [row.image, entryKey("bills", id, billId)].filter(Boolean) as string[]);
  return json({ ok: true });
});

// --- payments ---

on("GET", "/api/groups/:id/payments", async ({ env, email, p }) => {
  const [id] = p;
  if (!(await isMember(env, id, email))) return error("forbidden", 403);
  const { results } = await env.DB.prepare("SELECT * FROM payments WHERE group_id = ? ORDER BY created_at DESC, rowid DESC")
    .bind(id)
    .all<Record<string, unknown>>();
  return json(results.map(paymentOut));
});

on("POST", "/api/groups/:id/payments", async ({ req, env, email, p }) => {
  const [id] = p;
  if (!(await isMember(env, id, email))) return error("forbidden", 403);
  const body = await jsonBody(req);
  const amount = parseAmount(body.amount);
  if (!amount) return error("amount must be a positive integer (VND)");
  const allowed = new Set((await membersOf(env, id)).map((m) => m.email));
  const from = normEmail(body.from);
  const to = normEmail(body.to);
  if (!allowed.has(from) || !allowed.has(to)) return error("from and to must be members of this group");
  if (from === to) return error("from and to must differ");
  const payId = body.id === undefined ? crypto.randomUUID() : asId(body.id);
  if (!payId) return error("id must be a UUID");
  if (await env.DB.prepare("SELECT 1 AS ok FROM payments WHERE id = ?").bind(payId).first()) return error("id already used", 409);
  const payment = { id: payId, from, to, amount, createdBy: email, createdAt: new Date().toISOString() };
  const image = pickImage(body.image, entryKey("payments", id, payment.id));
  if (image && !(await env.IMAGES.head(image))) return error("image no longer exists", 409);
  await env.DB.prepare(
    "INSERT INTO payments (id, group_id, from_email, to_email, amount, image, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(payment.id, id, from, to, amount, image, email, payment.createdAt)
    .run();
  return json({ ...payment, image }, 201);
});

on("PATCH", "/api/groups/:id/payments/:payment", async ({ req, env, email, p }) => {
  const [id, paymentId] = p;
  if (!(await isMember(env, id, email))) return error("forbidden", 403);
  const row = await env.DB.prepare("SELECT * FROM payments WHERE id = ? AND group_id = ?")
    .bind(paymentId, id)
    .first<Record<string, unknown>>();
  if (!row) return error("not found", 404);
  const body = await jsonBody(req);
  const current = paymentOut(row);
  const amount = body.amount === undefined ? current.amount : parseAmount(body.amount);
  if (!amount) return error("amount must be a positive integer (VND)");
  const allowed = new Set((await membersOf(env, id)).map((m) => m.email));
  const from = body.from === undefined ? current.from : normEmail(body.from);
  const to = body.to === undefined ? current.to : normEmail(body.to);
  if (!allowed.has(from as string) || !allowed.has(to as string)) return error("from and to must be members of this group");
  if (from === to) return error("from and to must differ");
  const before = (current.image as string | null) ?? null;
  const image = body.image === undefined ? before : pickImage(body.image, entryKey("payments", id, paymentId));
  if (image && image !== before && !(await env.IMAGES.head(image))) return error("image no longer exists", 409);
  await env.DB.prepare("UPDATE payments SET from_email = ?, to_email = ?, amount = ?, image = ? WHERE id = ? AND group_id = ?")
    .bind(from, to, amount, image, paymentId, id)
    .run();
  if (before && before !== image) await deleteImages(env, [before]);
  return json({ ...current, from, to, amount, image });
});

on("DELETE", "/api/groups/:id/payments/:payment", async ({ env, email, p }) => {
  const [id, paymentId] = p;
  if (!(await isMember(env, id, email))) return error("forbidden", 403);
  const row = await env.DB.prepare("SELECT image FROM payments WHERE id = ? AND group_id = ?")
    .bind(paymentId, id)
    .first<{ image: string | null }>();
  if (!row) return error("not found", 404);
  await env.DB.prepare("DELETE FROM payments WHERE id = ? AND group_id = ?").bind(paymentId, id).run();
  await deleteImages(env, [row.image, entryKey("payments", id, paymentId)].filter(Boolean) as string[]);
  return json({ ok: true });
});

// --- summary ---

on("GET", "/api/groups/:id/summary", async ({ env, email, p }) => {
  const [id] = p;
  if (!(await isMember(env, id, email))) return error("forbidden", 403);
  const members = await membersOf(env, id);
  const nameOf = new Map(members.map((m) => [m.email, m.name]));
  const { results: bills } = await env.DB.prepare("SELECT amount, paid_by, participants FROM bills WHERE group_id = ?")
    .bind(id)
    .all<{ amount: number; paid_by: string; participants: string }>();
  const { results: payments } = await env.DB.prepare("SELECT amount, from_email, to_email FROM payments WHERE group_id = ?")
    .bind(id)
    .all<{ amount: number; from_email: string; to_email: string }>();

  const balances = new Map<string, number>(members.map((m) => [m.email, 0]));
  let totalSpent = 0;
  for (const b of bills) {
    totalSpent += b.amount;
    const participants = parse(b.participants, []);
    if (!participants.length) continue;
    balances.set(b.paid_by, (balances.get(b.paid_by) ?? 0) + b.amount);
    for (const [person, share] of split(b.amount, participants)) {
      balances.set(person, (balances.get(person) ?? 0) - share);
    }
  }
  for (const p of payments) {
    balances.set(p.from_email, (balances.get(p.from_email) ?? 0) + p.amount);
    balances.set(p.to_email, (balances.get(p.to_email) ?? 0) - p.amount);
  }

  const debtors = [...balances].filter(([, v]) => v < 0).map(([who, v]) => ({ who, v: -v })).sort((a, b) => b.v - a.v);
  const creditors = [...balances].filter(([, v]) => v > 0).map(([who, v]) => ({ who, v })).sort((a, b) => b.v - a.v);
  const settlements: { from: string; to: string; amount: number }[] = [];
  for (let i = 0, j = 0; i < debtors.length && j < creditors.length; ) {
    const amount = Math.min(debtors[i].v, creditors[j].v);
    if (amount > 0) settlements.push({ from: debtors[i].who, to: creditors[j].who, amount });
    debtors[i].v -= amount;
    creditors[j].v -= amount;
    if (!debtors[i].v) i++;
    if (!creditors[j].v) j++;
  }

  return json({
    totalSpent,
    balances: [...balances].map(([m, v]) => ({ email: m, name: nameOf.get(m) ?? m, balance: v })),
    settlements: settlements.map((t) => ({ ...t, fromName: nameOf.get(t.from) ?? t.from, toName: nameOf.get(t.to) ?? t.to })),
  });
});

// --- images ---

// The object is a function of the entry id, so the client states its intent and the Worker owns the key.
on("POST", "/api/groups/:id/bills/:bill/image", ({ req, env, email, p }) =>
  uploadImage(req, env, email, p[0], "bills", p[1]),
);
on("POST", "/api/groups/:id/payments/:payment/image", ({ req, env, email, p }) =>
  uploadImage(req, env, email, p[0], "payments", p[1]),
);

async function uploadImage(req: Request, env: Env, email: string, groupId: string, kind: "bills" | "payments", entryId: string) {
  if (!(await isMember(env, groupId, email))) return error("forbidden", 403);
  if (!/^[0-9a-f-]{36}$/.test(entryId)) return error("invalid id");
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return error("file field required");
  if (!file.type.startsWith("image/")) return error("only images are allowed");
  if (file.size > 8 * 1024 * 1024) return error("image must be under 8 MB");
  const key = entryKey(kind, groupId, entryId);
  await env.IMAGES.put(key, file, { httpMetadata: { contentType: file.type } });
  return json({ key, url: `/img/${key}` }, 201);
}

// --- profile QR ---

// A person's payment QR is visible to anyone who shares a group with them, which is the same audience
// that already sees their transfers in the summary.
async function canSeeQr(env: Env, viewer: string, owner: string) {
  if (viewer === owner) return true;
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM members a JOIN members b ON a.group_id = b.group_id
     WHERE a.email = ? AND b.email = ? LIMIT 1`,
  )
    .bind(viewer, owner)
    .first();
  return !!row;
}

on("POST", "/api/me/qr", async ({ req, env, email }) => {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return error("file field required");
  if (!file.type.startsWith("image/")) return error("only images are allowed");
  if (file.size > 8 * 1024 * 1024) return error("image must be under 8 MB");
  await env.IMAGES.put(qrKey(email), file, { httpMetadata: { contentType: file.type } });
  await env.DB.prepare(
    "INSERT INTO users (email, name, qr) VALUES (?, ?, ?) ON CONFLICT (email) DO UPDATE SET qr = excluded.qr",
  )
    .bind(email, email, qrKey(email))
    .run();
  return json({ qr: qrUrl(qrKey(email)) }, 201);
});

on("DELETE", "/api/me/qr", async ({ env, email }) => {
  await env.DB.prepare("UPDATE users SET qr = NULL WHERE email = ?").bind(email).run();
  await env.IMAGES.delete(qrKey(email)).catch(() => undefined);
  return json({ qr: null });
});

async function serveImage(env: Env, email: string, key: string) {
  const qr = /^qrs\/([^/]+)$/.exec(key);
  const entry = /^(bills|payments)\/([0-9a-f-]{36})\/[0-9a-f-]{36}$/.exec(key);
  const legacy = LEGACY_RE.exec(key);
  if (qr) {
    if (!(await canSeeQr(env, email, decodeURIComponent(qr[1])))) return error("forbidden", 403);
  } else if (entry) {
    if (!(await isMember(env, entry[2], email))) return error("forbidden", 403);
  } else if (legacy) {
    if (!(await isMember(env, legacy[1], email))) return error("forbidden", 403);
  } else return error("not found", 404);
  const obj = await env.IMAGES.get(key);
  if (!obj) return error("not found", 404);
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      etag: obj.httpEtag,
      "cache-control": "private, max-age=86400",
    },
  });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const email = normEmail(req.headers.get("cf-access-authenticated-user-email")) || (env.DEV_EMAIL ? normEmail(env.DEV_EMAIL) : "");
    if (!email) return error("unauthenticated", 401);
    if (url.pathname.startsWith("/img/")) return serveImage(env, email, url.pathname.slice("/img/".length));
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (m) return r.fn({ req, env, url, email, p: m.slice(1), ctx });
    }
    return error("not found", 404);
  },
};
