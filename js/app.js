// Copyright (c) 2026 KimJaeYoon01. All rights reserved. 무단 복제·수정·재배포를 금지합니다.
(function () {
  // green = 허용·유료(등록 야영장), free = 무료 노지(직접 모은 장소, 공식 허용지 아님)
  const COLORS = { red: "#e03131", yellow: "#f2b705", green: "#0a5c26", free: "#82c91e" };
  const LABELS = { red: "금지", yellow: "확인 필요", green: "허용 · 유료", free: "무료 노지" };

  // 팝업이 열릴 때 위쪽 제목줄(48px)에 가리지 않게 여백을 두고 지도를 움직임
  L.Popup.mergeOptions({ autoPanPaddingTopLeft: L.point(16, 64), autoPanPaddingBottomRight: L.point(16, 16) });
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
      ${p.tip ? `<p class="tip">💬 ${escapeHtml(p.tip)}</p>` : ""}
      ${p.addr ? `<p class="law">📍 ${escapeHtml(p.addr)}</p>` : ""}
      ${p.tel ? `<p class="law">☎ ${escapeHtml(p.tel)}</p>` : ""}
      ${safeUrl(p.url) && !/naver\.me/.test(p.url) ? `<p class="law"><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">자세히 보기 ↗</a></p>` : ""}
      ${p.lat ? `<p class="law"><a href="${escapeHtml(naverUrl(p))}" target="_blank" rel="noopener">네이버 지도에서 보기 ↗</a></p>` : ""}
      ${p.id ? `<div class="save-btns" data-id="${escapeHtml(p.id)}">
        <button type="button" data-list="favorite">☆ 즐겨찾기</button>
        <button type="button" data-list="wishlist" class="wish">⚑ 가고 싶은 곳</button></div>
      <div class="reviews" data-id="${escapeHtml(p.id)}"><p class="muted">후기 불러오는 중…</p></div>` : ""}
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
  // 면 데이터는 data/camp_areas/ 격자 파일로 따로 있어 가까이 볼 때 그 지역 것만 받음
  const AREA_ZOOM = 14;
  const campPts = [];                 // { id, layer, group }
  const campAreaById = new Map();     // id -> { layer, group } (불러온 면만)
  const campById = new Map();         // id -> 야영장 피처
  const campPopup = (f) => () => {    // 팝업 HTML 은 열 때 생성 (3천여 개를 미리 만들지 않음)
    const key = f.properties.fee === "free" ? "free" : "green";
    const [lon, lat] = f.geometry.coordinates;
    return popupHtml({ ...f.properties, status: key, lon, lat });
  };
  for (const f of window.CAMPSITES?.features || []) {
    const key = f.properties.fee === "free" ? "free" : "green";
    const [lon, lat] = f.geometry.coordinates;
    const pt = L.circleMarker([lat, lon], { ...styleFor(key), radius: 7, fillOpacity: 1 }).bindPopup(campPopup(f));
    campPts.push({ id: f.properties.id, layer: pt, group: groups[key] });
    campById.set(f.properties.id, f);
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

  // 가까이 보면 면이 있는 야영장은 점 대신 면을 보여줌 (면을 아직 못 받았으면 점 유지)
  let areaMode = null;
  function syncCamps() {
    for (const c of campPts) {
      const area = areaMode && campAreaById.get(c.id);
      if (area) { c.group.removeLayer(c.layer); area.group.addLayer(area.layer); }
      else c.group.addLayer(c.layer);
    }
    if (!areaMode) for (const a of campAreaById.values()) a.group.removeLayer(a.layer);
    reorder();
  }
  function updateCamps() {
    const mode = map.getZoom() >= AREA_ZOOM;
    if (mode !== areaMode) { areaMode = mode; syncCamps(); }
    if (mode) loadCampAreas();
  }

  let areaIndex = null;
  const areaRequested = new Set();
  async function loadCampAreas() {
    if (!areaIndex) {
      areaIndex = fetch("data/camp_areas/index.json").then((r) => r.json())
        .then((d) => ({ ...d, cellSet: new Set(d.cells) })).catch(() => null);
    }
    const idx = await areaIndex;
    if (!idx || !areaMode) return;
    const b = map.getBounds().pad(0.2), c = idx.cell;
    for (let x = Math.floor(b.getWest() / c); x <= Math.floor(b.getEast() / c); x++) {
      for (let y = Math.floor(b.getSouth() / c); y <= Math.floor(b.getNorth() / c); y++) {
        const key = `${x}_${y}`;
        if (!idx.cellSet.has(key) || areaRequested.has(key)) continue;
        areaRequested.add(key);
        fetch(`data/camp_areas/${key}.json`).then((r) => r.json()).then((areas) => {
          for (const [id, geom] of Object.entries(areas)) {
            const f = campById.get(id);
            if (!f || campAreaById.has(id)) continue;
            const status = f.properties.fee === "free" ? "free" : "green";
            const layer = L.geoJSON(geom, { style: () => styleFor(status) }).bindPopup(campPopup(f));
            campAreaById.set(id, { layer, group: groups[status] });
          }
          if (areaMode) syncCamps();
        }).catch((e) => { areaRequested.delete(key); console.error("야영장 면 불러오기 실패", key, e); });
      }
    }
  }
  map.on("zoomend", updateCamps);
  map.on("moveend", () => { if (areaMode) loadCampAreas(); });
  updateCamps();

  // 레이어 켜고 끄기 (구역 표시 체크박스)
  document.querySelectorAll("#legend [data-layer]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const g = groups[cb.dataset.layer];
      cb.checked ? g.addTo(map) : map.removeLayer(g);
      reorder(); // 다시 켜면 맨 위에 그려지므로 순서 복구
    });
  });

  // 안내 / 면책: 첫 방문에만 띄우고, 닫으면 기억 (내용은 ? 안내창에 항상 있음)
  document.getElementById("infoBtn").onclick = () => document.getElementById("infoDialog").showModal();
  const DISC_KEY = "nojicamp.disclaimer.v1";
  const disc = document.getElementById("disclaimer");
  try { disc.hidden = localStorage.getItem(DISC_KEY) === "1"; } catch { disc.hidden = false; }
  document.getElementById("closeDisc").onclick = () => {
    disc.hidden = true;
    try { localStorage.setItem(DISC_KEY, "1"); } catch { /* 무시 */ }
  };
  map.attributionControl.addAttribution('© 2026 모닥 · <a href="privacy.html" target="_blank" rel="noopener">개인정보처리방침</a>');

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
  const cellFiles = new Map(); // key -> Promise(상세본). 지도 표시·위치 판정·제보가 함께 씀
  function getCell(key) {
    if (!cellFiles.has(key)) {
      const job = getJSON(`data/zones/d/${key}.json`);
      job.catch(() => cellFiles.delete(key)); // 실패하면 다음에 다시 시도
      cellFiles.set(key, job);
    }
    return cellFiles.get(key);
  }

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
        getCell(key).then((fc) => {
          const fresh = { type: "FeatureCollection", features: fc.features.filter((f) => !detailDrawn.has(f.id) && detailDrawn.add(f.id)) };
          addZones(fresh, zoneDetail, zoneIndex.info);
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
    const fc = await getCell(key);
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
    const wasMin = locCard.classList.contains("min");
    locCard.className = `loc-card ${cls}${wasMin ? " min" : ""}`;
    locCard.innerHTML = `<button class="loc-close" aria-label="닫기">✕</button>
      <button class="loc-head" aria-label="카드 접기·펼치기">📍 ${escapeHtml(head)} <span class="loc-fold">${wasMin ? "▴" : "▾"}</span></button>
      <div class="loc-law">${escapeHtml(detail)}</div>
      <div class="loc-near">${near}</div>
      <div class="loc-acc">위치 오차 약 ${Math.round(acc)}m</div>`;
    locCard.hidden = false;
    locCard.querySelector(".loc-close").onclick = stopLocate;
    locCard.querySelector(".loc-head").onclick = () => {
      const min = locCard.classList.toggle("min");
      locCard.querySelector(".loc-fold").textContent = min ? "▴" : "▾";
    };
    if (needLift) { needLift = false; liftDot(); }
  }

  // 카드가 파란 점을 가리지 않게, 점이 카드 위쪽 빈 곳에 오도록 지도를 올림
  let needLift = false;
  function liftDot() {
    if (!myDot || locCard.hidden) return;
    const mapBox = map.getContainer().getBoundingClientRect();
    const cardTop = locCard.getBoundingClientRect().top;
    const dotY = mapBox.top + map.latLngToContainerPoint(myDot.getLatLng()).y;
    const target = mapBox.top + (cardTop - mapBox.top) / 2;
    if (dotY > cardTop - 40) map.panBy([0, dotY - target]);
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
    if (firstFix) { map.setView(ll, Math.max(map.getZoom(), 14), { animate: false }); firstFix = false; needLift = true; }
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

  // ---- 장소 제보 (＋ 버튼) ----
  // 지도 가운데 핀으로 위치를 고르면 좌표가 채워진 구글 설문지가 열림. 제보는 운영자가 확인 후 반영.
  const REPORT_FORM = {
    url: "https://docs.google.com/forms/d/e/1FAIpQLSc-BL4YJ6PR9SNBsKyvUjYiZhQl7DyvRGmlJSJuAbfR6vXoIQ/viewform",
    coords: "entry.12597568",  // '위치(좌표)' 질문
    zone: "entry.695150721",   // '구역 판정' 질문
  };
  const reportPin = document.getElementById("reportPin");
  const reportCard = document.getElementById("reportCard");
  let reporting = false, reportZone = "", reportSeq = 0;

  async function updateReportCard() {
    if (!reporting) return;
    const seq = ++reportSeq;
    const c = map.getCenter();
    const hits = await zonesAt(c.lat, c.lng);
    if (seq !== reportSeq || !reporting) return;
    const red = hits.find((h) => h.status === "red");
    const yellow = hits.filter((h) => h.status === "yellow");
    reportZone = red ? `금지: ${red.name}` : yellow.length ? `확인 필요: ${yellow.map((h) => h.name).join(", ")}` : "구역 밖";
    const warn = red ? `<div class="rp-warn red">⚠ 여기는 <b>${escapeHtml(red.name)}</b> 금지 구역이라 야영하면 안 돼요.</div>`
      : yellow.length ? `<div class="rp-warn yellow">여기는 확인이 필요한 구역이에요 (${escapeHtml(yellow.map((h) => h.name).join(", "))}).</div>`
      : `<div class="rp-warn none">표시된 금지·주의 구역 밖이에요.</div>`;
    const ready = !!REPORT_FORM.url;
    reportCard.innerHTML = `<div class="loc-head">＋ 무료 노지 제보</div>
      <div class="loc-law">지도를 움직여 가운데 핀을 제보할 자리에 맞춰 주세요.</div>
      ${warn}
      <div class="rp-coord">${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}</div>
      ${ready ? "" : `<div class="rp-warn yellow">제보 설문지가 아직 연결되지 않았어요.</div>`}
      <div class="rp-btns"><button type="button" class="rp-cancel">취소</button>
        <button type="button" class="rp-ok" ${ready && !red ? "" : "disabled"}>이 위치로 제보</button></div>`;
    reportCard.querySelector(".rp-cancel").onclick = stopReport;
    reportCard.querySelector(".rp-ok").onclick = () => {
      const params = new URLSearchParams({ usp: "pp_url" });
      if (REPORT_FORM.coords) params.set(REPORT_FORM.coords, `${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}`);
      if (REPORT_FORM.zone) params.set(REPORT_FORM.zone, reportZone);
      window.open(`${REPORT_FORM.url}?${params}`, "_blank", "noopener");
      stopReport();
    };
  }

  function startReport() {
    reporting = true;
    reportBtn.classList.add("active");
    map.closePopup();
    if (myDot) map.setView(myDot.getLatLng(), Math.max(map.getZoom(), 15));
    else if (map.getZoom() < 13) map.setZoom(13);
    locCard.hidden = true; // 같은 자리에 뜨는 내 위치 카드는 가림
    reportPin.hidden = false;
    reportCard.hidden = false;
    updateReportCard();
  }
  function stopReport() {
    reporting = false;
    reportBtn.classList.remove("active");
    reportPin.hidden = true;
    reportCard.hidden = true;
  }
  map.on("moveend", updateReportCard);

  const ReportControl = L.Control.extend({
    options: { position: "topleft" },
    onAdd() {
      const btn = L.DomUtil.create("button", "locate-btn report-btn");
      btn.type = "button";
      btn.title = "무료 노지 제보";
      btn.setAttribute("aria-label", "무료 노지 제보");
      btn.textContent = "＋";
      L.DomEvent.disableClickPropagation(btn);
      return btn;
    },
  });
  const reportBtn = new ReportControl().addTo(map).getContainer();
  reportBtn.addEventListener("click", () => (reporting ? stopReport() : startReport()));

  // ---- 검색 ----
  // 입력하는 대로 야영장(이름·주소) 목록, Enter 를 누르면 지역·주소 검색(OpenStreetMap Nominatim)
  const searchForm = document.getElementById("searchForm");
  const searchInput = document.getElementById("searchInput");
  const searchList = document.getElementById("searchResults");
  const norm = (t) => String(t || "").replace(/\s+/g, "").toLowerCase();
  const campIndex = (window.CAMPSITES?.features || []).map((f) => {
    const nk = norm(f.properties.name);
    return { f, nk, key: nk + "|" + norm(f.properties.addr), free: f.properties.fee === "free" };
  });
  let results = [], activeIdx = -1, placeSeq = 0;

  function localMatches(q) {
    const k = norm(q);
    if (k.length < 1) return [];
    const hits = campIndex.filter((c) => c.key.includes(k));
    // 이름에서 맞은 것 먼저, 무료 노지 먼저
    hits.sort((a, b) => (b.nk.includes(k) - a.nk.includes(k)) || (b.free - a.free));
    return hits.slice(0, 8).map((c) => ({ type: "camp", f: c.f }));
  }

  function renderResults(places, placeState) {
    const camps = localMatches(searchInput.value);
    results = [...camps, ...places];
    activeIdx = -1;
    const rows = [];
    if (camps.length) rows.push(`<li class="sr-head">야영장</li>`);
    camps.forEach((r, i) => {
      const p = r.f.properties, key = p.fee === "free" ? "free" : "green";
      rows.push(`<li data-i="${i}"><span class="sr-dot" style="background:${COLORS[key]}"></span>${escapeHtml(p.name)}
        <span class="sr-sub">${escapeHtml(LABELS[key])} · ${escapeHtml(p.addr || "")}</span></li>`);
    });
    if (placeState === "loading") rows.push(`<li class="sr-head">지역 검색 중…</li>`);
    if (places.length) rows.push(`<li class="sr-head">지역·주소</li>`);
    places.forEach((r, j) => {
      rows.push(`<li data-i="${camps.length + j}">📍 ${escapeHtml(r.name)}<span class="sr-sub">${escapeHtml(r.sub)}</span></li>`);
    });
    if (!camps.length && !places.length && placeState !== "loading") {
      rows.push(`<li class="sr-head">${searchInput.value.trim() ? "Enter 를 누르면 지역·주소를 검색합니다" : ""}</li>`);
    }
    searchList.innerHTML = rows.join("");
    searchList.hidden = !searchInput.value.trim();
  }

  async function searchPlaces(q) {
    const seq = ++placeSeq;
    renderResults([], "loading");
    try {
      const url = "https://nominatim.openstreetmap.org/search?" + new URLSearchParams({
        q, format: "jsonv2", countrycodes: "kr", limit: "6", "accept-language": "ko",
      });
      const data = await (await fetch(url)).json();
      if (seq !== placeSeq) return; // 그 사이 다른 검색을 했으면 무시
      renderResults(data.map((d) => ({
        type: "place", name: d.name || d.display_name.split(",")[0],
        sub: d.display_name.split(",").slice(1, 4).join(",").trim(),
        lat: +d.lat, lon: +d.lon, bbox: d.boundingbox?.map(Number),
      })), "done");
    } catch (e) {
      if (seq === placeSeq) renderResults([], "done");
      console.error("지역 검색 실패", e);
    }
  }

  function choose(r) {
    searchList.hidden = true;
    searchInput.blur();
    if (r.type === "camp") {
      openPlace(r.f.properties.id);
    } else if (r.bbox) {
      const [s, n, w, e] = r.bbox;
      map.fitBounds([[s, w], [n, e]], { maxZoom: 15 });
    } else {
      map.setView([r.lat, r.lon], 14);
    }
  }

  let typingTimer;
  searchInput.addEventListener("input", () => {
    clearTimeout(typingTimer);
    placeSeq++; // 입력이 바뀌면 진행 중인 지역 검색 결과는 버림
    typingTimer = setTimeout(() => renderResults([], "idle"), 120);
  });
  searchInput.addEventListener("focus", () => { if (searchInput.value.trim()) renderResults([], "idle"); });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!results.length) return;
      activeIdx = (activeIdx + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
      searchList.querySelectorAll("li[data-i]").forEach((li) => li.classList.toggle("active", +li.dataset.i === activeIdx));
    } else if (e.key === "Escape") {
      searchList.hidden = true;
    }
  });
  searchForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (activeIdx >= 0) { choose(results[activeIdx]); return; }
    const q = searchInput.value.trim();
    if (q) searchPlaces(q);
  });
  searchList.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li[data-i]");
    if (!li) return;
    e.preventDefault(); // 입력창 blur 로 목록이 먼저 닫히지 않게
    choose(results[+li.dataset.i]);
  });
  searchInput.addEventListener("blur", () => setTimeout(() => { searchList.hidden = true; }, 150));
  // ---- 로그인 · 즐겨찾기 · 가고 싶은 곳 ----
  // 로그인해야 저장 (Supabase saved_places 표). 로그인 전에 누르면 로그인 안내 후, 돌아오면 저장.
  // 공개용(publishable) 키이며, 데이터는 행 수준 보안(RLS)으로 본인 것만 접근 가능.
  const SUPABASE_URL = "https://qqwkjemfxlixmdkvfcju.supabase.co";
  const SUPABASE_KEY = "sb_publishable_lsBpp30OIsuAEI7_NcafsQ_6IBkYa4W";
  const sb = window.supabase?.createClient(SUPABASE_URL, SUPABASE_KEY);
  const LISTS = {
    favorite: { on: "⭐", off: "☆", label: "즐겨찾기" },
    wishlist: { on: "🚩", off: "⚑", label: "가고 싶은 곳" },
  };
  const placeById = campById;
  const saved = { favorite: new Map(), wishlist: new Map() }; // id -> { name, lon, lat }
  let user = null;

  const userBtn = document.getElementById("userBtn");
  const listBtn = document.getElementById("listBtn");
  const userDialog = document.getElementById("userDialog");
  const listDialog = document.getElementById("listDialog");

  async function loadRemote() {
    const { data, error } = await sb.from("saved_places")
      .select("place_id, list, name, lon, lat").order("created_at", { ascending: false });
    if (error) { console.error("목록 불러오기 실패", error); return; }
    for (const l of Object.keys(LISTS)) saved[l] = new Map();
    for (const r of data) saved[r.list]?.set(r.place_id, { name: r.name, lon: r.lon, lat: r.lat });
  }

  // 화면을 먼저 바꾸고 저장. 실패하면 되돌림
  async function toggleSaved(list, id) {
    const f = placeById.get(id);
    if (!f) return;
    if (!user) { askLogin(list, id); return; } // 로그인해야 저장됨 (저장된 줄 알고 잃어버리는 일 방지)
    const m = saved[list];
    const had = m.has(id);
    const v = { name: f.properties.name, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] };
    had ? m.delete(id) : m.set(id, v);
    const { error } = had
      ? await sb.from("saved_places").delete().match({ place_id: id, list })
      : await sb.from("saved_places").insert({ place_id: id, list, ...v });
    if (error) {
      had ? m.set(id, v) : m.delete(id);
      console.error("저장 실패", error);
      alert("저장하지 못했어요. 잠시 후 다시 시도해 주세요.");
    }
  }

  function paintSaveBtns(root) {
    root?.querySelectorAll(".save-btns").forEach((box) => {
      box.querySelectorAll("button[data-list]").forEach((b) => {
        const l = b.dataset.list, on = saved[l].has(box.dataset.id);
        b.classList.toggle("on", on);
        b.textContent = `${on ? LISTS[l].on : LISTS[l].off} ${LISTS[l].label}`;
      });
    });
  }

  map.on("popupopen", (e) => {
    const el = e.popup.getElement();
    paintSaveBtns(el);
    el.querySelectorAll(".save-btns button[data-list]").forEach((b) => {
      b.onclick = async () => {
        const job = toggleSaved(b.dataset.list, b.closest(".save-btns").dataset.id);
        paintSaveBtns(el);
        await job;
        paintSaveBtns(el);
      };
    });
  });

  function openPlace(id) {
    const f = placeById.get(id);
    if (!f) return;
    const key = f.properties.fee === "free" ? "free" : "green";
    const [lon, lat] = f.geometry.coordinates;
    map.setView([lat, lon], 15);
    L.popup().setLatLng([lat, lon]).setContent(popupHtml({ ...f.properties, status: key, lon, lat })).openOn(map);
  }

  function renderUserBtn() {
    if (user) {
      const pic = user.user_metadata?.avatar_url;
      userBtn.innerHTML = pic ? `<img src="${escapeHtml(pic)}" alt="" referrerpolicy="no-referrer">` : "🙂";
      userBtn.title = "내 계정";
    } else {
      userBtn.textContent = "👤";
      userBtn.title = "로그인";
    }
  }

  // 로그인 전에 누른 ⭐/🚩 는 기억해 뒀다가 로그인하고 돌아오면 저장
  const PENDING_KEY = "nojicamp.pending.v1";
  function askLogin(list, id) {
    try { sessionStorage.setItem(PENDING_KEY, JSON.stringify({ list, id })); } catch { /* 무시 */ }
    const name = placeById.get(id)?.properties.name || "이 장소";
    openUserDialog(`${LISTS[list].on} <b>${escapeHtml(name)}</b>을(를) ${LISTS[list].label}에 저장하려면 로그인해 주세요. 로그인하고 돌아오면 바로 저장돼요.`);
  }
  async function applyPending() {
    let p = null;
    try { p = JSON.parse(sessionStorage.getItem(PENDING_KEY)); sessionStorage.removeItem(PENDING_KEY); } catch { /* 무시 */ }
    if (p && LISTS[p.list] && placeById.has(p.id) && !saved[p.list].has(p.id)) {
      await toggleSaved(p.list, p.id);
      openPlace(p.id); // 저장된 모습을 바로 보여줌
    }
  }

  function openUserDialog(message) {
    if (!sb) { alert("로그인 기능을 불러오지 못했어요. 잠시 후 다시 시도해 주세요."); return; }
    if (!user && typeof message !== "string") {
      try { sessionStorage.removeItem(PENDING_KEY); } catch { /* 무시 */ } // 그냥 로그인 버튼으로 연 경우
    }
    userDialog.innerHTML = user ? `
      <h2>내 계정</h2>
      <p>🏕 <b>${escapeHtml(myProfile?.nickname || "")}</b>
        <button class="linkish" data-act="nick">닉네임 변경</button>
        <button class="linkish" data-act="myreviews">내 후기 보기</button><br>
        <span class="muted">${escapeHtml(user.email || "")}</span></p>
      <p class="muted">⭐ 즐겨찾기 ${saved.favorite.size}곳 · 🚩 가고 싶은 곳 ${saved.wishlist.size}곳<br>
        회원 탈퇴는 <a href="privacy.html" target="_blank" rel="noopener">개인정보처리방침</a>의 문의처로 요청해 주세요.</p>
      <div class="row-btns"><button data-act="close">닫기</button><button data-act="logout">로그아웃</button></div>` : `
      <h2>로그인</h2>
      ${typeof message === "string" ? `<p class="login-msg">${message}</p>` : ""}
      <p class="muted">로그인하면 ⭐ 즐겨찾기와 🚩 가고 싶은 곳을 저장하고, 휴대폰·PC 어디서나 볼 수 있어요.</p>
      <button class="login-btn kakao" data-act="kakao"><b>💬</b> 카카오로 로그인</button>
      <button class="login-btn google-btn" data-act="google"><b style="color:#4285f4">G</b> 구글로 로그인</button>
      <p class="muted">로그인하면 이메일·이름(닉네임)·프로필 사진을 받아 목록 저장에만 사용합니다.
        <a href="privacy.html" target="_blank" rel="noopener">개인정보처리방침</a></p>
      <div class="row-btns"><button data-act="close">닫기</button></div>`;
    if (!userDialog.open) userDialog.showModal();
  }

  let listTab = "favorite";
  function renderList() {
    if (!user) {
      listDialog.innerHTML = `
        <h2>내 목록</h2>
        <p>⭐ 즐겨찾기와 🚩 가고 싶은 곳은 <b>로그인하면</b> 쓸 수 있어요.</p>
        <p class="muted">카카오나 구글 계정으로 10초면 로그인돼요. 저장한 목록은 휴대폰·PC 어디서나 볼 수 있어요.</p>
        <div class="row-btns"><button data-act="close">닫기</button><button class="primary" data-act="login">로그인</button></div>`;
      return;
    }
    const items = [...saved[listTab]].map(([id, v]) => `
      <li><button class="go" data-go="${escapeHtml(id)}">${escapeHtml(v.name)}
        <small>${escapeHtml(placeById.get(id)?.properties.addr || "")}</small></button>
        <button class="del" data-del="${escapeHtml(id)}">삭제</button></li>`).join("");
    listDialog.innerHTML = `
      <h2>내 목록</h2>
      <div class="tabs">${Object.entries(LISTS).map(([k, v]) =>
        `<button data-tab="${k}" class="${k === listTab ? "on" : ""}">${v.on} ${v.label} ${saved[k].size}</button>`).join("")}</div>
      <ul class="saved-list">${items || `<li class="muted">아직 없어요. 지도에서 장소를 누르고 ${LISTS[listTab].off} ${LISTS[listTab].label} 버튼을 눌러 보세요.</li>`}</ul>
      <div class="row-btns"><button data-act="close">닫기</button></div>`;
  }

  userBtn.addEventListener("click", () => openUserDialog());
  listBtn.addEventListener("click", () => { renderList(); if (!listDialog.open) listDialog.showModal(); });

  userDialog.addEventListener("click", async (e) => {
    if (e.target === userDialog) { userDialog.close(); return; } // 바깥(배경) 클릭
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "close") userDialog.close();
    if (act === "logout") { await sb.auth.signOut(); userDialog.close(); }
    if (act === "myreviews") { userDialog.close(); openCamperPage(user.id); }
    if (act === "nick") {
      const next = prompt("새 닉네임 (2~20자, 30일에 한 번 바꿀 수 있어요)", myProfile?.nickname || "");
      if (next == null) return;
      const nick = next.trim();
      if (nick.length < 2 || nick.length > 20) { alert("닉네임은 2~20자로 정해 주세요."); return; }
      const { error } = await sb.from("profiles").update({ nickname: nick }).eq("user_id", user.id);
      if (error?.code === "23505") alert("이미 누가 쓰고 있는 닉네임이에요.");
      else if (error?.code === "P0001") alert("닉네임은 30일에 한 번만 바꿀 수 있어요.");
      else if (error) { alert("바꾸지 못했어요."); console.error(error); }
      else { await loadMyProfile(); reviewCache.clear(); openUserDialog(); }
    }
    if (act === "google" || act === "kakao") {
      await sb.auth.signInWithOAuth({ provider: act, options: { redirectTo: location.origin + location.pathname } });
    }
  });

  listDialog.addEventListener("click", async (e) => {
    if (e.target === listDialog) { listDialog.close(); return; }
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.act === "close") listDialog.close();
    if (t.dataset.act === "login") { listDialog.close(); openUserDialog(); }
    if (t.dataset.tab) { listTab = t.dataset.tab; renderList(); }
    if (t.dataset.go) { listDialog.close(); openPlace(t.dataset.go); }
    if (t.dataset.del) { await toggleSaved(listTab, t.dataset.del); renderList(); }
  });

  async function onSession(session) {
    const next = session?.user || null;
    if ((next?.id || null) === (user?.id || null)) return;
    user = next;
    if (user) {
      await loadRemote();
    } else {
      for (const l of Object.keys(LISTS)) saved[l] = new Map();
    }
    renderUserBtn();
    if (listDialog.open) renderList();
    paintSaveBtns(document.querySelector(".leaflet-popup"));
    if (user) await applyPending();
  }

  renderUserBtn();
  // onAuthStateChange 안에서 바로 Supabase 를 호출하면 멈출 수 있어 다음 틱으로 미룸
  sb?.auth.onAuthStateChange((_event, session) => setTimeout(() => onSession(session), 0));
  // ---- 장소 후기 (별점·한 줄 후기·방문일·태그, 신고) ----
  // Supabase reviews / review_reports 표. 보기는 누구나, 쓰기는 로그인, 삭제는 본인·관리자(RLS).
  const TAGS = ["🚻 화장실", "🚰 물", "🔥 취사 가능", "🚗 차박 가능", "🐶 반려견", "🌙 조용함", "📶 통신 잘 됨", "⚠️ 통제·공사"];
  const reviewDialog = document.getElementById("reviewDialog");
  let isAdmin = false;
  const reviewCache = new Map(); // place_id -> 후기 배열

  const REVIEW_COLS = "id, place_id, user_id, rating, content, visited_on, tags, created_at, updated_at, profiles(nickname)";
  const nickOf = (r) => r.profiles?.nickname || "캠퍼";
  let myProfile = null; // { nickname, nickname_changed_at }
  const stars = (n) => "★".repeat(n) + "☆".repeat(5 - n);
  const fmtDate = (d) => (d ? String(d).slice(0, 10).replaceAll("-", ".") : "");

  async function fetchReviews(placeId, force = false) {
    if (!force && reviewCache.has(placeId)) return reviewCache.get(placeId);
    const { data, error } = await sb.from("reviews")
      .select(REVIEW_COLS)
      .eq("place_id", placeId).order("created_at", { ascending: false }).limit(100);
    if (error) throw error;
    reviewCache.set(placeId, data);
    return data;
  }

  function reviewItem(r) {
    const mine = user && r.user_id === user.id;
    const actions = [
      mine ? `<button data-rv="edit">수정</button><button data-rv="delete" data-rid="${r.id}">삭제</button>` : "",
      !mine && isAdmin ? `<button data-rv="delete" data-rid="${r.id}">관리자 삭제</button>` : "",
      !mine ? `<button data-rv="report" data-rid="${r.id}">신고</button>` : "",
    ].join("");
    return `<li class="rv">
      <div class="rv-head"><span class="rv-stars">${stars(r.rating)}</span>
        <button class="rv-nick" data-rv="camper" data-uid="${escapeHtml(r.user_id)}" title="이 캠퍼의 후기 모두 보기">${escapeHtml(nickOf(r))}</button>
        <span class="muted">${r.visited_on ? `${fmtDate(r.visited_on)} 방문` : fmtDate(r.created_at)}</span></div>
      ${r.tags?.length ? `<div class="rv-tags">${r.tags.map((t) => `<span>${escapeHtml(t)}</span>`).join("")}</div>` : ""}
      <p class="rv-text">${escapeHtml(r.content)}</p>
      <div class="rv-actions">${actions}</div></li>`;
  }

  function renderReviews(box, list, expanded = false) {
    const id = box.dataset.id;
    const n = list.length;
    const avg = n ? list.reduce((s, r) => s + r.rating, 0) / n : 0;
    // 태그는 많이 언급된 순으로 요약
    const tagCount = {};
    list.forEach((r) => (r.tags || []).forEach((t) => { tagCount[t] = (tagCount[t] || 0) + 1; }));
    const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const mineWritten = user && list.some((r) => r.user_id === user.id);
    const shown = expanded ? list : list.slice(0, 3);
    box.innerHTML = `
      <div class="rv-summary">
        ${n ? `<span class="rv-stars">${stars(Math.round(avg))}</span> <b>${avg.toFixed(1)}</b> <span class="muted">후기 ${n}개</span>`
            : `<span class="muted">아직 후기가 없어요. 첫 후기를 남겨 주세요!</span>`}
      </div>
      ${topTags.length ? `<div class="rv-tags">${topTags.map(([t, c]) => `<span>${escapeHtml(t)} ${c}</span>`).join("")}</div>` : ""}
      <ul class="rv-list">${shown.map(reviewItem).join("")}</ul>
      ${n > shown.length ? `<button class="rv-more" data-rv="more">후기 ${n - shown.length}개 더 보기</button>` : ""}
      <button class="rv-write" data-rv="write">✍ ${mineWritten ? "내 후기 수정" : "후기 쓰기"}</button>`;
    box.onclick = (e) => onReviewAction(e, box, id);
  }

  // 팝업 위쪽이 제목줄 밑으로 들어가면 그만큼 지도를 아래로 내려 팝업 전체가 보이게
  function keepPopupInView(popup) {
    const el = popup?.getElement();
    if (!el || !map.hasLayer(popup)) return;
    const top = el.getBoundingClientRect().top;
    const limit = document.querySelector(".topbar").getBoundingClientRect().bottom + 12;
    if (top < limit) map.panBy([0, top - limit]);
  }

  async function loadReviewBox(box, force = false, expanded = false) {
    try {
      renderReviews(box, await fetchReviews(box.dataset.id, force), expanded);
    } catch (e) {
      console.error("후기 불러오기 실패", e);
      box.innerHTML = `<p class="muted">후기를 불러오지 못했어요.</p>`;
    }
  }

  async function onReviewAction(e, box, placeId) {
    const b = e.target.closest("[data-rv]");
    if (!b) return;
    const act = b.dataset.rv;
    const list = reviewCache.get(placeId) || [];
    if (act === "more") { renderReviews(box, list, true); keepPopupInView(map._popup); return; }
    if (act === "camper") { openCamperPage(b.dataset.uid); return; }
    if (!user) {
      const name = placeById.get(placeId)?.properties.name || "이 장소";
      openUserDialog(`✍ <b>${escapeHtml(name)}</b> 후기를 쓰거나 신고하려면 로그인해 주세요.`);
      return;
    }
    if (act === "write" || act === "edit") openReviewForm(placeId, list.find((r) => r.user_id === user.id), box);
    if (act === "delete") {
      if (!confirm("이 후기를 삭제할까요?")) return;
      const { error } = await sb.from("reviews").delete().eq("id", +b.dataset.rid);
      if (error) { alert("삭제하지 못했어요."); console.error(error); return; }
      loadReviewBox(box, true);
    }
    if (act === "report") openReportForm(+b.dataset.rid);
  }

  // 닉네임은 사람마다 하나로 고정 (profiles 표). 가입 때 자동 생성, 내 계정에서 30일에 한 번 변경
  async function loadMyProfile() {
    myProfile = null;
    if (!user) return;
    const { data, error } = await sb.from("profiles").select("nickname, nickname_changed_at").eq("user_id", user.id).maybeSingle();
    if (error) console.error("프로필 불러오기 실패", error);
    myProfile = data;
  }

  // 한 캠퍼의 후기 모음 (취향 맞는 캠퍼 따라가기)
  async function openCamperPage(uid) {
    const { data, error } = await sb.from("reviews").select(REVIEW_COLS)
      .eq("user_id", uid).order("created_at", { ascending: false }).limit(200);
    if (error) { alert("불러오지 못했어요."); console.error(error); return; }
    const nick = data[0] ? nickOf(data[0]) : "캠퍼";
    const avg = data.length ? (data.reduce((a, r) => a + r.rating, 0) / data.length).toFixed(1) : "-";
    reviewDialog.innerHTML = `
      <h2>🏕 ${escapeHtml(nick)} 님의 후기</h2>
      <p class="muted">후기 ${data.length}개 · 평균 별점 ${avg}</p>
      <ul class="saved-list camper-list">${data.map((r) => `
        <li><button class="go" data-go="${escapeHtml(r.place_id)}">
          <span class="rv-stars">${stars(r.rating)}</span> ${escapeHtml(placeById.get(r.place_id)?.properties.name || "장소")}
          <small>${r.visited_on ? `${fmtDate(r.visited_on)} 방문 · ` : ""}${escapeHtml(r.content.slice(0, 60))}${r.content.length > 60 ? "…" : ""}</small>
        </button></li>`).join("") || `<li class="muted">아직 후기가 없어요.</li>`}</ul>
      <div class="row-btns"><button data-act="close">닫기</button></div>`;
    reviewDialog.onclick = (e) => {
      if (e.target === reviewDialog || e.target.closest("[data-act=close]")) { reviewDialog.close(); return; }
      const go = e.target.closest("[data-go]");
      if (go) { reviewDialog.close(); openPlace(go.dataset.go); }
    };
    if (!reviewDialog.open) reviewDialog.showModal();
  }
  // 한국 시간(기기 시간) 기준 오늘 날짜 YYYY-MM-DD (toISOString 은 UTC 라 새벽에 하루 전이 됨)
  function todayLocal() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function openReviewForm(placeId, mine, box) {
    const name = placeById.get(placeId)?.properties.name || "";
    const r = mine || { rating: 0, content: "", visited_on: todayLocal(), tags: [] };
    reviewDialog.onclick = (e) => { if (e.target === reviewDialog) reviewDialog.close(); };
    reviewDialog.innerHTML = `
      <form method="dialog" class="rv-form">
        <h2>✍ ${escapeHtml(name)} 후기</h2>
        <div class="rv-rate" role="radiogroup" aria-label="별점">
          ${[1, 2, 3, 4, 5].map((n) => `<label><input type="radio" name="rating" value="${n}" ${r.rating === n ? "checked" : ""} required><span>★</span></label>`).join("")}
        </div>
        <textarea name="content" rows="4" maxlength="500" minlength="2" required
          placeholder="화장실·물·자리 상황, 분위기 등 다른 캠퍼에게 도움이 될 이야기를 남겨 주세요.">${escapeHtml(r.content)}</textarea>
        <label class="rv-field">방문한 날 <input type="date" name="visited_on" value="${escapeHtml(r.visited_on || "")}" max="${todayLocal()}"></label>
        <div class="rv-tagpick">${TAGS.map((t) => `<label><input type="checkbox" name="tags" value="${escapeHtml(t)}" ${r.tags?.includes(t) ? "checked" : ""}><span>${escapeHtml(t)}</span></label>`).join("")}</div>
        <p class="rv-field">작성자 <b>${escapeHtml(myProfile?.nickname || "캠퍼")}</b>
          <span class="muted">(닉네임은 👤 내 계정에서 바꿀 수 있어요)</span></p>
        <p class="muted">욕설·광고·개인정보가 담긴 후기는 삭제될 수 있어요. 닉네임과 후기 내용은 모두에게 공개돼요.</p>
        <div class="row-btns"><button value="cancel" formnovalidate>취소</button><button class="primary" value="ok">${mine ? "수정" : "등록"}</button></div>
      </form>`;
    const form = reviewDialog.querySelector("form");
    form.onsubmit = async (e) => {
      if (e.submitter?.value !== "ok") return;
      e.preventDefault();
      const fd = new FormData(form);
      const row = {
        rating: +fd.get("rating"),
        content: String(fd.get("content")).trim(),
        visited_on: fd.get("visited_on") || null,
        tags: fd.getAll("tags"),
        updated_at: new Date().toISOString(),
      };
      const { error } = mine
        ? await sb.from("reviews").update(row).eq("id", mine.id)
        : await sb.from("reviews").insert({ place_id: placeId, ...row });
      if (error) { alert("저장하지 못했어요. 잠시 후 다시 시도해 주세요."); console.error(error); return; }
      reviewDialog.close();
      loadReviewBox(box, true).then(() => keepPopupInView(map._popup));
    };
    if (!reviewDialog.open) reviewDialog.showModal();
  }

  function openReportForm(reviewId) {
    reviewDialog.onclick = (e) => { if (e.target === reviewDialog) reviewDialog.close(); };
    reviewDialog.innerHTML = `
      <form method="dialog">
        <h2>🚩 후기 신고</h2>
        <textarea name="reason" rows="3" maxlength="300" required placeholder="신고 이유를 적어 주세요 (욕설, 광고, 허위 정보, 개인정보 노출 등)"></textarea>
        <div class="row-btns"><button value="cancel" formnovalidate>취소</button><button class="primary" value="ok">신고</button></div>
      </form>`;
    const form = reviewDialog.querySelector("form");
    form.onsubmit = async (e) => {
      if (e.submitter?.value !== "ok") return;
      e.preventDefault();
      const { error } = await sb.from("review_reports")
        .insert({ review_id: reviewId, reason: String(new FormData(form).get("reason")).trim() });
      reviewDialog.close();
      if (error?.code === "23505") alert("이미 신고한 후기예요.");
      else if (error) { alert("신고하지 못했어요."); console.error(error); }
      else alert("신고가 접수됐어요. 확인 후 조치할게요.");
    };
    if (!reviewDialog.open) reviewDialog.showModal();
  }

  map.on("popupopen", (e) => {
    const box = e.popup.getElement().querySelector(".reviews");
    if (!box || !sb) return;
    // popup.update() 는 내용을 처음 HTML 로 되돌리므로 쓰지 않음. 내용이 늘어난 뒤 화면 밖으로 나가면 지도를 옮김
    loadReviewBox(box).then(() => keepPopupInView(e.popup));
  });

  // 로그인 상태가 바뀌면 관리자 여부 확인, 열린 팝업 후기 다시 그림
  sb?.auth.onAuthStateChange((_event, session) => setTimeout(async () => {
    isAdmin = false;
    await loadMyProfile();
    if (session?.user) {
      const { data } = await sb.rpc("is_admin");
      isAdmin = !!data;
    }
    const box = document.querySelector(".leaflet-popup .reviews");
    if (box) renderReviews(box, reviewCache.get(box.dataset.id) || []);
  }, 0));
  // ---- 순위 (🏆) ----
  // Supabase 함수 rank_saved / rank_reviews / rank_campers 로 "몇 번"만 셈 (누가 저장했는지는 안 드러남)
  const rankDialog = document.getElementById("rankDialog");
  const RANK_TABS = {
    favorite: { label: "⭐ 즐겨찾기", unit: "명이 즐겨찾기" },
    wishlist: { label: "🚩 가고 싶은 곳", unit: "명이 가고 싶어 해요" },
    rating:   { label: "👍 별점 좋은 곳", unit: "" },
    reviews:  { label: "✍ 후기 많은 곳", unit: "" },
    campers:  { label: "🏕 활동 캠퍼", unit: "" },
  };
  const rankState = { tab: "favorite", days: null, freeOnly: false };
  const rankCache = new Map();

  async function fetchRank({ tab, days }) {
    const key = `${tab}:${days}`;
    if (rankCache.has(key)) return rankCache.get(key);
    let q;
    if (tab === "favorite" || tab === "wishlist") q = sb.rpc("rank_saved", { p_list: tab, p_days: days, p_limit: 100 });
    else if (tab === "rating") q = sb.rpc("rank_reviews", { p_order: "rating", p_days: days, p_min: 2, p_limit: 100 });
    else if (tab === "reviews") q = sb.rpc("rank_reviews", { p_order: "count", p_days: days, p_min: 1, p_limit: 100 });
    else q = sb.rpc("rank_campers", { p_days: days, p_limit: 50 });
    const { data, error } = await q;
    if (error) throw error;
    rankCache.set(key, data);
    setTimeout(() => rankCache.delete(key), 60000); // 1분 뒤 새로 받음
    return data;
  }

  const medal = (i) => ["🥇", "🥈", "🥉"][i] || `${i + 1}`;

  async function renderRank() {
    const { tab, days, freeOnly } = rankState;
    rankDialog.innerHTML = `
      <h2>🏆 순위</h2>
      <div class="tabs rank-tabs">${Object.entries(RANK_TABS).map(([k, v]) =>
        `<button data-rtab="${k}" class="${k === tab ? "on" : ""}">${v.label}</button>`).join("")}</div>
      <div class="rank-filters">
        <button data-days="" class="${days == null ? "on" : ""}">전체 기간</button>
        <button data-days="30" class="${days === 30 ? "on" : ""}">최근 30일</button>
        ${tab !== "campers" ? `<label><input type="checkbox" data-free ${freeOnly ? "checked" : ""}> 무료 노지만</label>` : ""}
      </div>
      <ol class="rank-list"><li class="muted">불러오는 중…</li></ol>
      <div class="row-btns"><button data-act="close">닫기</button></div>`;
    let rows;
    try { rows = await fetchRank(rankState); } catch (e) {
      console.error("순위 불러오기 실패", e);
      rankDialog.querySelector(".rank-list").innerHTML = `<li class="muted">순위를 불러오지 못했어요.</li>`;
      return;
    }
    if (rankState.tab !== tab || rankState.days !== days || rankState.freeOnly !== freeOnly) return; // 그 사이 탭 바뀜
    let html;
    if (tab === "campers") {
      html = rows.map((r, i) => `
        <li><span class="rank-no">${medal(i)}</span>
          <button class="go" data-camper="${escapeHtml(r.user_id)}">🏕 ${escapeHtml(r.nickname)}
            <small>후기 ${r.cnt}개 · 평균 ★ ${Number(r.avg_rating).toFixed(1)}</small></button></li>`).join("");
    } else {
      const list = rows.filter((r) => placeById.has(r.place_id))
        .filter((r) => !freeOnly || placeById.get(r.place_id).properties.fee === "free").slice(0, 30);
      html = list.map((r, i) => {
        const p = placeById.get(r.place_id).properties;
        const stat = tab === "rating" ? `★ ${Number(r.avg_rating).toFixed(1)} · 후기 ${r.cnt}개`
          : tab === "reviews" ? `후기 ${r.cnt}개 · ★ ${Number(r.avg_rating).toFixed(1)}`
          : `${r.cnt}${RANK_TABS[tab].unit}`;
        return `<li><span class="rank-no">${medal(i)}</span>
          <button class="go" data-go="${escapeHtml(r.place_id)}">
            <span class="sr-dot" style="background:${COLORS[p.fee === "free" ? "free" : "green"]}"></span>${escapeHtml(p.name)}
            <small>${escapeHtml(stat)} · ${escapeHtml(p.addr || "")}</small></button></li>`;
      }).join("");
    }
    const empty = tab === "rating" ? "후기가 2개 이상 모인 장소가 아직 없어요." : "아직 데이터가 없어요. 첫 번째가 되어 보세요!";
    rankDialog.querySelector(".rank-list").innerHTML = html || `<li class="muted">${empty}</li>`;
  }

  rankDialog.addEventListener("click", (e) => {
    if (e.target === rankDialog) { rankDialog.close(); return; }
    const t = e.target.closest("button, input");
    if (!t) return;
    if (t.dataset.act === "close") rankDialog.close();
    if (t.dataset.rtab) { rankState.tab = t.dataset.rtab; renderRank(); }
    if (t.dataset.days !== undefined) { rankState.days = t.dataset.days ? +t.dataset.days : null; renderRank(); }
    if (t.hasAttribute("data-free")) { rankState.freeOnly = t.checked; renderRank(); }
    if (t.dataset.go) { rankDialog.close(); openPlace(t.dataset.go); }
    if (t.dataset.camper) { rankDialog.close(); openCamperPage(t.dataset.camper); }
  });
  document.getElementById("rankBtn").addEventListener("click", () => {
    if (!sb) { alert("순위를 불러오지 못했어요."); return; }
    renderRank();
    if (!rankDialog.open) rankDialog.showModal();
  });
})();
