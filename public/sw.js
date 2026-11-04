// Push notifications, a failed-navigation fallback, and a precache of the three PWA files.
//
// Why those three are precached: Chrome fetches a <link rel="manifest"> target without credentials.
// Behind Cloudflare Access that request is answered with a 302 to the login origin, and Chrome refuses
// to parse a manifest that arrived cross-origin — the installer reports "No manifest detected" and the
// install prompt disappears. Serving it from Cache Storage means the request never reaches Access.
//
// Only the manifest and icons are cached. The app itself is not: every screen needs /api/*, so a cached
// shell could only render an empty page, and caching it is what forced a hand-bumped version string on
// every deploy. Bump CACHE when the manifest or the icons change.
const CACHE = "bills-meta-v1";
const META = ["/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  // One put at a time: addAll rejects the whole batch on a single failure, and a rejected install means
  // no worker ever activates. A missing icon should cost that icon, not the worker.
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(META.map((u) => fetch(u).then((r) => (r.ok ? c.put(u, r) : null)).catch(() => null))))
      .then(() => self.skipWaiting()),
  );
});

// Old caches are left alone. Bumping CACHE opens a fresh one, and the previous bills-meta-* entries stay
// behind harmlessly; deleting by prefix is the part that once risked touching other Cache Storage.
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// The offline page is carried in this file rather than cached, so there is nothing to invalidate and
// nothing to go stale: the worker and its fallback always ship together.
const OFFLINE = `<!doctype html>
<html lang="vi">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hoá đơn chung · Shared Bills</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-content: center; gap: 8px;
    padding: 24px; text-align: center;
    font: 400 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #f9f6f2; color: #1d1a17;
  }
  h1 { margin: 0; font-size: 1.25rem; letter-spacing: -0.015em; }
  p { margin: 0; max-width: 34ch; color: #55504a; }
  button {
    justify-self: center; margin-top: 8px; min-height: 38px; padding: 0 16px;
    border: 1px solid #1d1a17; border-radius: 6px; background: #1d1a17; color: #f9f6f2;
    font: inherit; font-size: 0.875rem; font-weight: 500; cursor: pointer;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #101419; color: #eef1f5; }
    p { color: #a9b1bb; }
    button { background: #eef1f5; border-color: #eef1f5; color: #101419; }
  }
</style>
<h1>Không có kết nối</h1>
<p>Hoá đơn cần mạng. Khi có kết nối lại, trang sẽ tải đúng dữ liệu của bạn.</p>
<p lang="en">No connection. Bills needs the network; your data loads as soon as you are back online.</p>
<button onclick="location.reload()">Thử lại · Retry</button>
`;

// A navigation that cannot reach the network gets that page instead of the browser's error. Nothing
// else is intercepted: assets and the API go straight to the network, as they always did.
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  // The manifest and icons must not depend on the network answering: see the note at the top.
  if (META.includes(url.pathname)) {
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request).catch(() => new Response("", { status: 504 }))));
    return;
  }

  if (request.mode !== "navigate") return;
  event.respondWith(
    fetch(request).catch(() => new Response(OFFLINE, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })),
  );
});

self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload = {};
  try { payload = event.data.json(); } catch { payload = { title: "bills", body: event.data.text() }; }
  event.waitUntil(
    self.registration.showNotification(payload.title || "bills", {
      body: payload.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: payload.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const open = wins.find((w) => w.url === url);
      return open ? open.focus() : self.clients.openWindow(url);
    }),
  );
});
