// Copyright (c) 2026 KimJaeYoon01. All rights reserved. 무단 복제·수정·재배포를 금지합니다.
(function () {
  // green = 허용·유료(등록 야영장), free = 무료 노지(직접 모은 장소, 공식 허용지 아님)
  const COLORS = { red: "#e03131", yellow: "#f2b705", green: "#0a5c26", free: "#82c91e" };
  const LABELS = { red: "금지", yellow: "확인 필요", green: "허용 · 유료", free: "무료 노지" };

  const map = L.map("map", { zoomControl: true }).setView([36.5, 127.8], 7);
  window.nojiMap = map; // 디버깅용
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  // 모든 도형을 캔버스 하나에 그림 (캔버스를 여러 장 겹치면 아래 장이 클릭되지 않음)
  // 그리는 순서로 겹침 제어: 노랑(맨 아래) → 빨강 → 초록(맨 위, 야영장 점)
  const renderer = L.canvas({ padding: 0.5, tolerance: 4 });
  const groups = { red: L.featureGroup(), yellow: L.featureGroup(), green: L.featureGroup(), free: L.featureGroup() };
  Object.values(groups).forEach((g) => g.addTo(map));

  // 그리는 순서 복구: 노랑 맨 아래, 초록(유료 → 무료) 맨 위
  function reorder() {
    groups.yellow.bringToBack();
    groups.green.bringToFront();
    groups.free.bringToFront();
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function safeUrl(u) { return typeof u === "string" && /^https?:\/\//i.test(u); }

  // 네이버 지도: 이 장소 좌표를 중심으로 이름(없으면 주소)을 검색한 화면
  function naverUrl(p) {
    const q = encodeURIComponent(p.name || p.addr || "");
    return `https://map.naver.com/p/search/${q}?c=${p.lon.toFixed(6)},${p.lat.toFixed(6)},16,0,0,0,dh`;
  }

  function popupHtml(p) {
    return `<div class="popup">
      <h3>${escapeHtml(p.name)}</h3>
      <span class="badge ${p.status}">${LABELS[p.status]}</span>
      <p class="law">${escapeHtml(p.law)}</p>
      ${p.addr ? `<p class="law">📍 ${escapeHtml(p.addr)}</p>` : ""}
      ${p.tel ? `<p class="law">☎ ${escapeHtml(p.tel)}</p>` : ""}
      ${safeUrl(p.url) && !/naver\.me/.test(p.url) ? `<p class="law"><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">자세히 보기 ↗</a></p>` : ""}
      ${p.lat ? `<p class="law"><a href="${escapeHtml(naverUrl(p))}" target="_blank" rel="noopener">네이버 지도에서 보기 ↗</a></p>` : ""}
      ${p.source ? `<p class="law"><small>출처: ${escapeHtml(p.source)}</small></p>` : ""}
    </div>`;
  }

  function styleFor(status) {
    const c = COLORS[status];
    // 초록(허용)은 배경지도의 숲 색과 구분되도록 진하게 + 검정 테두리
    if (status === "green" || status === "free") {
      return { color: "#000", weight: 2, fillColor: c, fillOpacity: status === "free" ? 0.9 : 0.75, renderer };
    }
    return { color: c, weight: 1.5, fillColor: c, fillOpacity: 0.35, renderer };
  }

  // 빨강·노랑 구역 도형을 target[status] 그룹에 추가
  // 파일 속성은 압축형: s=색, n=이름, k=index.json info(법령·출처) 번호
  function addZones(geojson, target, info) {
    L.geoJSON(geojson, {
      style: (f) => styleFor(f.properties.s),
      onEachFeature: (f, layer) => {
        const { s: status, n: name, k } = f.properties;
        layer.options.renderer = renderer;
        layer.bindPopup(() => popupHtml({ status, name, ...info[k] })); // 팝업 HTML 은 열 때 생성
        target[status]?.addLayer(layer);
      },
    });
  }

  // 야영장: 멀리서는 점, 가까이(AREA_ZOOM 이상)에서는 지적도 필지 경계(면)
  const AREA_ZOOM = 14;
  const campPts = [];
  const campAreas = [];
  for (const f of window.CAMPSITES?.features || []) {
    const key = f.properties.fee === "free" ? "free" : "green";
    const [lon, lat] = f.geometry.coordinates;
    const p = { ...f.properties, status: key, lon, lat };
    const pt = L.circleMarker([lat, lon], { ...styleFor(key), radius: 7, fillOpacity: 1 })
      .bindPopup(popupHtml(p));
    campPts.push({ layer: pt, group: groups[key], hasArea: !!p.area });
    if (p.area) {
      const area = L.geoJSON(p.area, { style: () => styleFor(key) }).bindPopup(popupHtml(p));
      campAreas.push({ layer: area, group: groups[key] });
    }
  }
  // 멀리서 볼수록 점을 작게 (전국 화면에서 3천여 개 점이 지도를 덮지 않도록)
  function dotSize(z) {
    if (z <= 7) return { radius: 2, weight: 0.5 };
    if (z <= 9) return { radius: 3.5, weight: 1 };
    if (z <= 11) return { radius: 5, weight: 1.5 };
    return { radius: 7, weight: 2 };
  }
  let lastDot = null;
  function resizeDots() {
    const d = dotSize(map.getZoom());
    if (lastDot && d.radius === lastDot.radius) return;
    lastDot = d;
    for (const c of campPts) c.layer.setRadius(d.radius).setStyle({ weight: d.weight });
  }
  map.on("zoomend", resizeDots);
  resizeDots();

  let areaMode = null;
  function updateCamps() {
    const mode = map.getZoom() >= AREA_ZOOM;
    if (mode === areaMode) return;
    areaMode = mode;
    for (const c of campPts) {
      if (mode && c.hasArea) c.group.removeLayer(c.layer);
      else c.group.addLayer(c.layer);
    }
    for (const a of campAreas) mode ? a.group.addLayer(a.layer) : a.group.removeLayer(a.layer);
    reorder();
  }
  map.on("zoomend", updateCamps);
  updateCamps();

  // 레이어 토글
  document.querySelectorAll("[data-layer]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const g = groups[cb.dataset.layer];
      cb.checked ? g.addTo(map) : map.removeLayer(g);
      // 다시 켜면 맨 위에 그려지므로 순서 복구
      reorder();
    });
  });

  // 안내 / 면책
  document.getElementById("infoBtn").onclick = () => document.getElementById("infoDialog").showModal();
  document.getElementById("closeDisc").onclick = () => document.getElementById("disclaimer").remove();

  // ---- 빨강·노랑 구역 (scripts/build_zones.py 로 미리 만든 정적 파일) ----
  // 멀리서는 전국 요약본(overview.json), 가까이(detailZoom 이상)서는 격자별 상세본(d/X_Y.json)
  const statusEl = document.getElementById("status");
  function setStatus(msg) { statusEl.textContent = msg; statusEl.hidden = !msg; }

  const zoneOverview = { red: L.featureGroup(), yellow: L.featureGroup() };
  const zoneDetail = { red: L.featureGroup(), yellow: L.featureGroup() };
  let zoneIndex = null;
  const detailRequested = new Set();
  const detailDrawn = new Set(); // 격자 경계에 걸친 구역 중복 방지 (피처 id)
  let pending = 0;

  function updateLoading() {
    setStatus(pending ? `구역 불러오는 중… (${pending})` : "");
  }

  async function getJSON(url) {
    pending++; updateLoading();
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return await res.json();
    } finally {
      pending--; updateLoading();
    }
  }

  let detailMode = null;
  function switchZoneMode() {
    if (!zoneIndex) return;
    const mode = map.getZoom() >= zoneIndex.detailZoom;
    if (mode === detailMode) return;
    detailMode = mode;
    for (const st of ["red", "yellow"]) {
      groups[st].removeLayer(mode ? zoneOverview[st] : zoneDetail[st]);
      groups[st].addLayer(mode ? zoneDetail[st] : zoneOverview[st]);
    }
    reorder();
  }

  function loadDetail() {
    if (!zoneIndex || map.getZoom() < zoneIndex.detailZoom) return;
    const c = zoneIndex.cell;
    const b = map.getBounds().pad(0.2);
    for (let x = Math.floor(b.getWest() / c); x <= Math.floor(b.getEast() / c); x++) {
      for (let y = Math.floor(b.getSouth() / c); y <= Math.floor(b.getNorth() / c); y++) {
        const key = `${x}_${y}`;
        if (!zoneIndex.cellSet.has(key) || detailRequested.has(key)) continue;
        detailRequested.add(key);
        getJSON(`data/zones/d/${key}.json`).then((fc) => {
          fc.features = fc.features.filter((f) => !detailDrawn.has(f.id) && detailDrawn.add(f.id));
          addZones(fc, zoneDetail, zoneIndex.info);
          reorder();
        }).catch((e) => {
          detailRequested.delete(key); // 실패한 칸은 다음 이동 때 다시 시도
          console.error("구역 상세본 불러오기 실패", key, e);
        });
      }
    }
  }

  Promise.all([getJSON("data/zones/index.json"), getJSON("data/zones/overview.json")])
    .then(([index, overview]) => {
      zoneIndex = { ...index, cellSet: new Set(index.cells) };
      addZones(overview, zoneOverview, zoneIndex.info);
      switchZoneMode();
      loadDetail();
      map.on("zoomend", switchZoneMode);
      map.on("moveend", loadDetail);
    })
    .catch((e) => {
      console.error("구역 데이터 불러오기 실패", e);
      setStatus("구역 데이터를 불러오지 못했습니다");
    });

  // ---- 내 위치 (GPS) ----
  // 버튼을 누르면 위치를 계속 따라가며, 선 곳의 구역과 가까운 야영장을 알려줌
  const locCard = document.getElementById("locCard");
  const cellCache = new Map(); // 구역 판정용 상세본 (지도 표시와 별개로 내 위치 칸만 받음)
  let myDot = null, myCircle = null, watchId = null, firstFix = true, lastCheck = null;

  function pointInRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function pointInGeom(x, y, g) {
    const polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
    return polys.some((p) => pointInRing(x, y, p[0]) && !p.slice(1).some((h) => pointInRing(x, y, h)));
  }

  async function zonesAt(lat, lon) {
    if (!zoneIndex) return [];
    const key = `${Math.floor(lon / zoneIndex.cell)}_${Math.floor(lat / zoneIndex.cell)}`;
    if (!zoneIndex.cellSet.has(key)) return [];
    if (!cellCache.has(key)) cellCache.set(key, fetch(`data/zones/d/${key}.json`).then((r) => r.json()));
    const fc = await cellCache.get(key);
    return fc.features
      .filter((f) => pointInGeom(lon, lat, f.geometry))
      .map((f) => ({ status: f.properties.s, name: f.properties.n, law: zoneIndex.info[f.properties.k].law }));
  }

  function distKm(lat1, lon1, lat2, lon2) {
    const kx = 111.32 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
    return Math.hypot((lon1 - lon2) * kx, (lat1 - lat2) * 110.54);
  }
  function nearest(lat, lon, fee) {
    let best = null;
    for (const f of window.CAMPSITES?.features || []) {
      if ((f.properties.fee === "free") !== (fee === "free")) continue;
      const [x, y] = f.geometry.coordinates;
      const d = distKm(lat, lon, y, x);
      if (!best || d < best.d) best = { d, f };
    }
    return best;
  }
  function fmtKm(d) { return d < 1 ? `${Math.round(d * 1000)}m` : `${d.toFixed(1)}km`; }

  async function describe(lat, lon, acc) {
    const hits = await zonesAt(lat, lon);
    const red = hits.find((h) => h.status === "red");
    const yellow = hits.filter((h) => h.status === "yellow");
    let head, cls;
    if (red) { head = `금지 구역 · ${red.name}`; cls = "red"; }
    else if (yellow.length) { head = `확인 필요 · ${yellow.map((h) => h.name).join(", ")}`; cls = "yellow"; }
    else { head = "표시된 금지·주의 구역 밖"; cls = "none"; }
    const detail = red ? red.law : yellow[0]?.law || "금지 구역은 아니지만 토지 소유자·조례·현장 안내판을 확인하세요";
    const free = nearest(lat, lon, "free"), paid = nearest(lat, lon, "paid");
    const near = [
      free && `무료 노지 <b>${escapeHtml(free.f.properties.name)}</b> ${fmtKm(free.d)}`,
      paid && `야영장 <b>${escapeHtml(paid.f.properties.name)}</b> ${fmtKm(paid.d)}`,
    ].filter(Boolean).join("<br>");
    locCard.className = `loc-card ${cls}`;
    locCard.innerHTML = `<button class="loc-close" aria-label="닫기">✕</button>
      <div class="loc-head">📍 ${escapeHtml(head)}</div>
      <div class="loc-law">${escapeHtml(detail)}</div>
      <div class="loc-near">${near}</div>
      <div class="loc-acc">위치 오차 약 ${Math.round(acc)}m</div>`;
    locCard.hidden = false;
    locCard.querySelector(".loc-close").onclick = stopLocate;
  }

  function onPosition(pos) {
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;
    const ll = [lat, lon];
    if (!myDot) {
      myCircle = L.circle(ll, { radius: accuracy, color: "#1c7ed6", weight: 1, fillOpacity: 0.1, interactive: false }).addTo(map);
      myDot = L.circleMarker(ll, { radius: 8, color: "#fff", weight: 3, fillColor: "#1c7ed6", fillOpacity: 1 }).addTo(map);
    } else {
      myDot.setLatLng(ll);
      myCircle.setLatLng(ll).setRadius(accuracy);
    }
    if (firstFix) { map.setView(ll, Math.max(map.getZoom(), 14)); firstFix = false; }
    // 20m 이상 움직였을 때만 구역 다시 판정
    if (!lastCheck || distKm(lat, lon, lastCheck[0], lastCheck[1]) > 0.02) {
      lastCheck = ll;
      describe(lat, lon, accuracy);
    }
  }

  function onPosError(err) {
    const msg = err.code === 1 ? "위치 권한이 거부되었습니다. 브라우저 설정에서 이 사이트의 위치 권한을 허용해 주세요."
      : "현재 위치를 찾지 못했습니다. 잠시 후 다시 시도해 주세요.";
    locCard.className = "loc-card none";
    locCard.innerHTML = `<button class="loc-close" aria-label="닫기">✕</button><div class="loc-law">${msg}</div>`;
    locCard.hidden = false;
    locCard.querySelector(".loc-close").onclick = stopLocate;
    stopLocate(false);
  }

  function stopLocate(hideCard = true) {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    locBtn.classList.remove("active");
    if (hideCard) {
      locCard.hidden = true;
      if (myDot) { map.removeLayer(myDot); map.removeLayer(myCircle); myDot = myCircle = null; }
    }
  }

  const LocateControl = L.Control.extend({
    options: { position: "topleft" },
    onAdd() {
      const btn = L.DomUtil.create("button", "locate-btn");
      btn.type = "button";
      btn.title = "내 위치";
      btn.setAttribute("aria-label", "내 위치");
      btn.textContent = "◎";
      L.DomEvent.disableClickPropagation(btn);
      return btn;
    },
  });
  const locBtn = new LocateControl().addTo(map).getContainer();
  locBtn.addEventListener("click", () => {
    if (watchId !== null) { stopLocate(); return; }
    if (!("geolocation" in navigator)) { onPosError({ code: 0 }); return; }
    firstFix = true; lastCheck = null;
    locBtn.classList.add("active");
    watchId = navigator.geolocation.watchPosition(onPosition, onPosError,
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
  });
})();
