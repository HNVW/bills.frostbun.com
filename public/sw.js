// Push notifications only. The app is not cached: every screen needs /api/*, so a cached shell could
// only ever render an empty page, and its version string had to be bumped by hand with every deploy.

self.addEventListener("install", () => self.skipWaiting());

// Older versions of this worker cached the shell under bills-vN. Drop only those: deleting every key
// would take out any other Cache Storage the origin owns.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("bills-")).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

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
  if (request.method !== "GET" || request.mode !== "navigate") return;
  if (new URL(request.url).origin !== location.origin) return;
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
