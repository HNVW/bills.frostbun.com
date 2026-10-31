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
    `SELECT m.email, COALESCE(u.name, m.email) AS name
     FROM members m LEFT JOIN users u ON u.email = m.email
     WHERE m.group_id = ? ORDER BY m.created_at, m.email`,
  )
    .bind(groupId)
    .all<{ email: string; name: string }>();
  return results;
}

async function deleteImages(env: Env, keys: string[]) {
  await Promise.all(keys.map((k) => env.IMAGES.delete(k).catch(() => undefined)));
}

// Uploads are tracked until a bill/payment references them, so nothing can become unreachable silently.
// The sweep only touches tracked keys older than the grace window; saving verifies the object still exists.
const UPLOAD_TTL_MS = 60 * 60 * 1000;

async function referencedImages(env: Env) {
  const referenced = new Set<string>();
  for (const table of ["bills", "payments"]) {
    const { results } = await env.DB.prepare(`SELECT images FROM ${table}`).all<{ images: string }>();
    for (const r of results) for (const k of parse(r.images, [])) referenced.add(k);
  }
  return referenced;
}

async function untrackUploads(env: Env, keys: string[]) {
  if (!keys.length) return;
  await env.DB.batch(keys.map((k) => env.DB.prepare("DELETE FROM uploads WHERE key = ?").bind(k)));
}

async function collectOrphanImages(env: Env) {
  const cutoff = new Date(Date.now() - UPLOAD_TTL_MS).toISOString();
  const { results } = await env.DB.prepare("SELECT key FROM uploads WHERE created_at <= ?").bind(cutoff).all<{ key: string }>();
  if (!results.length) return 0;
  const referenced = await referencedImages(env);
  const stale = results.map((r) => r.key).filter((k) => !referenced.has(k));
  await Promise.all(stale.map((k) => env.IMAGES.delete(k).catch(() => undefined)));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM uploads WHERE created_at <= ?").bind(cutoff),
    ...stale.map((k) => env.DB.prepare("DELETE FROM uploads WHERE key = ?").bind(k)),
  ]);
  return stale.length;
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
  const vapid = { subject: env.VAPID_SUBJECT ?? "mailto:noreply@frostbun.com", publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
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
  images: parse(b.images as string, []),
  createdBy: b.created_by,
  createdAt: b.created_at,
});

const paymentOut = (p: Record<string, unknown>) => ({
  id: p.id,
  groupId: p.group_id,
  from: p.from_email,
  to: p.to_email,
  amount: p.amount,
  images: parse(p.images as string, []),
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

async function missingObjects(env: Env, keys: string[]) {
  for (const key of keys) if (!(await env.IMAGES.head(key))) return key;
  return "";
}

function parseImages(v: unknown, groupId: string): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return null;
  const prefix = `${groupId}/`;
  const out: string[] = [];
  for (const k of v) {
    if (typeof k !== "string" || !k.startsWith(prefix) || k.includes("..")) return null;
    out.push(k);
  }
  return out.slice(0, 10);
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
  // A browser rotates its endpoint on every resubscribe, so old rows for this user are dead weight.
  // Dropping them keeps one row per user per browser and bounds the table at any number of off/on toggles.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM push_subscriptions WHERE email = ? AND endpoint <> ?").bind(email, endpoint),
    env.DB.prepare(
      `INSERT INTO push_subscriptions (endpoint, email, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET email = excluded.email, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at`,
    ).bind(endpoint, email, p256dh, auth, new Date().toISOString()),
  ]);
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
  const row = await env.DB.prepare("SELECT name FROM users WHERE email = ?").bind(email).first<{ name: string }>();
  return json({ email, name: row?.name ?? email });
});

on("PATCH", "/api/me", async ({ req, env, email }) => {
  const raw = (await jsonBody(req)).name;
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name || name.length > 60) return error("name required (1-60 chars)");
  await env.DB.prepare("INSERT INTO users (email, name) VALUES (?, ?) ON CONFLICT (email) DO UPDATE SET name = excluded.name")
    .bind(email, name)
    .run();
  return json({ email, name });
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
  return json({ groups: results.map((g) => ({ ...groupOut(g), updatedAt: g.updated_at })), total: total?.c ?? 0, limit, offset });
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
  const keys: string[] = [];
  for (const table of ["bills", "payments"]) {
    const { results } = await env.DB.prepare(`SELECT images FROM ${table} WHERE group_id = ?`)
      .bind(id)
      .all<{ images: string }>();
    for (const r of results) keys.push(...parse(r.images, []));
  }
  const { results: tracked } = await env.DB.prepare("SELECT key FROM uploads WHERE group_id = ?").bind(id).all<{ key: string }>();
  await deleteImages(env, [...keys, ...tracked.map((t) => t.key)]);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM bills WHERE group_id = ?").bind(id),
    env.DB.prepare("DELETE FROM payments WHERE group_id = ?").bind(id),
    env.DB.prepare("DELETE FROM members WHERE group_id = ?").bind(id),
    env.DB.prepare("DELETE FROM uploads WHERE group_id = ?").bind(id),
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
  const images = parseImages(body.images, id);
  if (!images) return error("images must be keys uploaded for this group");
  const missing = await missingObjects(env, images);
  if (missing) return error(`image no longer exists: ${missing}`, 409);
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
  const bill = {
    id: crypto.randomUUID(),
    title,
    amount,
    paidBy,
    participants,
    images,
    createdAt: new Date().toISOString(),
    createdBy: email,
  };
  await env.DB.prepare(
    "INSERT INTO bills (id, group_id, title, amount, paid_by, participants, images, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(bill.id, id, bill.title, bill.amount, bill.paidBy, JSON.stringify(participants), JSON.stringify(images), email, bill.createdAt)
    .run();
  ctx.waitUntil(notifyBillCreated(env, id, email, bill).catch(() => undefined));
  return json(bill, 201);
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
  const images = body.images === undefined ? current.images : parseImages(body.images, id);
  if (!images) return error("images must be keys uploaded for this group");
  const missing = await missingObjects(env, images);
  if (missing) return error(`image no longer exists: ${missing}`, 409);
  const title = body.title === undefined ? current.title : typeof body.title === "string" ? body.title.trim().slice(0, 200) : current.title;
  const removed = current.images.filter((k: string) => !images.includes(k));
  await env.DB.prepare(
    "UPDATE bills SET title = ?, amount = ?, paid_by = ?, participants = ?, images = ? WHERE id = ? AND group_id = ?",
  )
    .bind(title, amount, paidBy, JSON.stringify(participants), JSON.stringify(images), billId, id)
    .run();
  await deleteImages(env, removed);
  await untrackUploads(env, removed);
  return json({ ...current, title, amount, paidBy, participants, images });
});

on("DELETE", "/api/groups/:id/bills/:bill", async ({ env, email, p }) => {
  const [id, billId] = p;
  if (!(await isMember(env, id, email))) return error("forbidden", 403);
  const row = await env.DB.prepare("SELECT images FROM bills WHERE id = ? AND group_id = ?")
    .bind(billId, id)
    .first<{ images: string }>();
  if (!row) return error("not found", 404);
  await env.DB.prepare("DELETE FROM bills WHERE id = ? AND group_id = ?").bind(billId, id).run();
  const keys = parse(row.images, []);
  await deleteImages(env, keys);
  await untrackUploads(env, keys);
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
  const images = parseImages(body.images, id);
  if (!images) return error("images must be keys uploaded for this group");
  const missing = await missingObjects(env, images);
  if (missing) return error(`image no longer exists: ${missing}`, 409);
  const payment = { id: crypto.randomUUID(), from, to, amount, images, createdBy: email, createdAt: new Date().toISOString() };
  await env.DB.prepare(
    "INSERT INTO payments (id, group_id, from_email, to_email, amount, images, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(payment.id, id, from, to, amount, JSON.stringify(images), email, payment.createdAt)
    .run();
  return json(payment, 201);
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
  const images = body.images === undefined ? current.images : parseImages(body.images, id);
  if (!images) return error("images must be keys uploaded for this group");
  const missing = await missingObjects(env, images);
  if (missing) return error(`image no longer exists: ${missing}`, 409);
  const removed = current.images.filter((k: string) => !images.includes(k));
  await env.DB.prepare("UPDATE payments SET from_email = ?, to_email = ?, amount = ?, images = ? WHERE id = ? AND group_id = ?")
    .bind(from, to, amount, JSON.stringify(images), paymentId, id)
    .run();
  await deleteImages(env, removed);
  await untrackUploads(env, removed);
  return json({ ...current, from, to, amount, images });
});

on("DELETE", "/api/groups/:id/payments/:payment", async ({ env, email, p }) => {
  const [id, paymentId] = p;
  if (!(await isMember(env, id, email))) return error("forbidden", 403);
  const row = await env.DB.prepare("SELECT images FROM payments WHERE id = ? AND group_id = ?")
    .bind(paymentId, id)
    .first<{ images: string }>();
  if (!row) return error("not found", 404);
  await env.DB.prepare("DELETE FROM payments WHERE id = ? AND group_id = ?").bind(paymentId, id).run();
  const keys = parse(row.images, []);
  await deleteImages(env, keys);
  await untrackUploads(env, keys);
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

on("POST", "/api/groups/:id/images", async ({ req, env, email, p }) => {
  const [id] = p;
  if (!(await isMember(env, id, email))) return error("forbidden", 403);
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return error("file field required");
  if (!file.type.startsWith("image/")) return error("only images are allowed");
  if (file.size > 8 * 1024 * 1024) return error("image must be under 8 MB");
  const ext = (file.name.split(".").pop() ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin";
  const key = `${id}/${crypto.randomUUID()}.${ext}`;
  await env.IMAGES.put(key, file, { httpMetadata: { contentType: file.type } });
  await env.DB.prepare("INSERT INTO uploads (key, group_id, created_at) VALUES (?, ?, ?)")
    .bind(key, id, new Date().toISOString())
    .run();
  return json({ key, url: `/img/${key}` }, 201);
});

async function serveImage(env: Env, email: string, key: string) {
  const m = /^([0-9a-f-]{36})\/[A-Za-z0-9-]+\.[a-z0-9]{1,8}$/.exec(key);
  if (!m) return error("not found", 404);
  if (!(await isMember(env, m[1], email))) return error("forbidden", 403);
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
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await collectOrphanImages(env);
  },

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
