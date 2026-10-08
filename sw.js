// 캠이웃 오프라인 대비 (앱처럼 설치했을 때)
// - 화면 파일(assets/이름-해시.js 등)은 바뀌지 않으므로 저장해 두고 바로 씀
// - 그 밖(첫 화면·지도 자료)은 항상 인터넷에서 새로 받고, 끊겼을 때만 저장해 둔 것을 씀 → 옛 화면이 남는 일 없음
// - 지도 그림(타일)·다른 사이트 요청은 건드리지 않음
const CACHE = "camiut-v2";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.includes("/assets/")) {
    e.respondWith(caches.open(CACHE).then(async (c) => (await c.match(req)) || fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; })));
    return;
  }
  e.respondWith(fetch(req).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return r;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || Response.error())));
});

// 📲 휴대폰 알림 (supabase/functions/push 가 보냄): {title, body, url, tag}
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "캠이웃", {
    body: d.body || "", tag: d.tag, icon: "icon-512.png", badge: "icon-512.png", data: { url: d.url || "/" },
  }));
});
// 알림을 누르면: 열려 있는 캠이웃 창이 있으면 그 창을, 없으면 새로 열기
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    const w = list.find((c) => new URL(c.url).origin === self.location.origin);
    if (w) return w.navigate(url).then((c) => (c || w).focus());
    return self.clients.openWindow(url);
  }));
});
