// 캠이웃 오프라인 대비 (앱처럼 설치했을 때)
// - 화면 파일(assets/이름-해시.js 등)은 바뀌지 않으므로 저장해 두고 바로 씀
// - 그 밖(첫 화면·지도 자료)은 항상 인터넷에서 새로 받고, 끊겼을 때만 저장해 둔 것을 씀 → 옛 화면이 남는 일 없음
// - 지도 그림(타일)·다른 사이트 요청은 건드리지 않음
const CACHE = "camiut-v1";
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
