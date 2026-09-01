/* 지도 + 파라미터 UI. 점수 계산은 전부 score.js 가 한다. */

import {
  prepare, computeRanking, financials, exclusionReasons,
  FLAG, GRADE_LABELS,
} from "./score.js";

/* MapLibre 는 `zoom` 을 최상위 interpolate/step 에서만 허용한다.
 * 따라서 zoom 을 바깥에 두고 case 를 안쪽에 넣는다. */
const fillOpacity = (exOpacity) => {
  const c = ["boolean", ["feature-state", "cand"], false];
  return ["interpolate", ["linear"], ["zoom"],
    11, ["case", c, 0.72, exOpacity],
    15, ["case", c, 0.82, exOpacity]];
};

/* dataviz 순차 블루 램프. 순위가 높을수록 짙다. */
const RAMP = [
  "#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec",
  "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab",
  "#184f95", "#104281", "#0d366b",
];
const SEOUNGBUK = [127.0175, 37.6065];

/* 베이스맵은 배경이지 주인공이 아니다. 채도를 낮춰 필지 색이 살게 하고,
 * 다크모드에서는 밝기까지 눌러 흰 종이처럼 뜨지 않게 한다. */
const isDark = () => document.documentElement.dataset.theme === "dark";
const BASEMAP_PAINT = () => isDark()
  ? { "raster-opacity": 0.38, "raster-saturation": -0.7, "raster-brightness-max": 0.72 }
  : { "raster-opacity": 0.55, "raster-saturation": -0.55 };

const $ = (id) => document.getElementById(id);
const won = (v) =>
  v >= 1e8 ? `${(v / 1e8).toFixed(1)}억`
  : v >= 1e4 ? `${Math.round(v / 1e4).toLocaleString()}만`
  : Math.round(v).toLocaleString();

const state = {
  meta: null, D: null, idx: null, result: null,
  selected: null, map: null, painted: new Set(), zoneNames: null,
};

/* ── 파라미터 읽기 ─────────────────────────────────────── */
function readParams() {
  const d = state.meta.defaults;
  return {
    tol_profitability_pct: +$("tol1").value,
    tol_solar_pct: +$("tol2").value,
    monthly_rent_per_room: +$("rent").value * 1e4,
    deposit_per_room: +$("deposit").value * 1e4,
    unit_construction_cost: +$("cc").value * 1e4,
    land_price_multiplier: +$("mult").value / 100,
    room_area_sqm: +$("roomA").value,
    denominator: $("denom").value,
    min_rooms: +$("minRooms").value,
    grades: { A: +$("gA").value, B: +$("gB").value, C: +$("gC").value, D: +$("gD").value },
    soft_cost_ratio: d.soft_cost_ratio,
    demolition_cost_per_sqm: d.demolition_cost_per_sqm,
    net_area_ratio: d.net_area_ratio,
    vacancy_rate: d.vacancy_rate,
    opex_ratio: d.opex_ratio,
  };
}

function syncLabels() {
  $("tol1v").textContent = $("tol1").value;
  $("tol2v").textContent = $("tol2").value;
  $("rentv").textContent = $("rent").value;
  $("depositv").textContent = (+$("deposit").value).toLocaleString();
  $("ccv").textContent = $("cc").value;
  $("multv").textContent = (+$("mult").value / 100).toFixed(2);
  $("roomAv").textContent = $("roomA").value;
  $("minRoomsv").textContent = $("minRooms").value;
  for (const g of ["A", "B", "C", "D"]) $(`g${g}v`).textContent = $(`g${g}`).value;
}

/* 등급 임계는 단조 증가해야 한다. 하나를 올리면 뒤를 밀어낸다. */
function enforceGradeOrder(changed) {
  const ids = ["gA", "gB", "gC", "gD"];
  const i = ids.indexOf(changed);
  if (i < 0) return;
  for (let k = i + 1; k < ids.length; k++) {
    const prev = +$(ids[k - 1]).value;
    if (+$(ids[k]).value <= prev) $(ids[k]).value = String(prev + 25);
  }
  for (let k = i - 1; k >= 0; k--) {
    const next = +$(ids[k + 1]).value;
    if (+$(ids[k]).value >= next) $(ids[k]).value = String(next - 25);
  }
}

/* ── 계산 + 지도 반영 ──────────────────────────────────── */
function recompute() {
  const P = readParams();
  const t0 = performance.now();
  const res = computeRanking(state.D, P, { excludeSubdivided: $("exSub").checked });
  state.result = res;
  state.P = P;

  const n = res.order.length;
  $("candCount").textContent = n ? `${n.toLocaleString()}` : "";

  // 순위 → feature-state. 이전에 칠한 것 중 후보에서 빠진 것은 지운다.
  const map = state.map;
  const src = { source: "parcels", sourceLayer: "parcels" };
  const next = new Set();
  for (let r = 0; r < n; r++) {
    const i = res.order[r];
    const id = state.D.ids[i];
    next.add(id);
    // 1위 -> 1.0(가장 진함), 꼴찌 -> 0.0.
    // sqrt 로 상위 구간을 넓혀 최상위 필지가 눈에 띄게 한다.
    const lin = n > 1 ? r / (n - 1) : 0;
    map.setFeatureState({ ...src, id }, { pct: Math.sqrt(1 - lin), cand: true });
  }
  for (const id of state.painted) {
    if (!next.has(id)) map.setFeatureState({ ...src, id }, { pct: null, cand: false });
  }
  state.painted = next;

  renderList(res, P);
  if (state.selected) renderDetail(state.selected);
  return performance.now() - t0;
}

function renderList(res, P) {
  const body = $("listBody");
  const top = res.order.slice(0, 60);
  if (!top.length) {
    body.innerHTML =
      `<div class="empty">조건을 만족하는 필지가 없습니다.<br>최소 실 수를 낮추거나 임대료 가정을 확인해 보세요.</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  top.forEach((i, r) => {
    const id = state.D.ids[i];
    const row = document.createElement("div");
    row.className = "row";
    row.setAttribute("role", "option");
    row.tabIndex = 0;
    row.dataset.id = id;
    row.setAttribute("aria-selected", state.selected === id ? "true" : "false");
    const sub = state.D.flags[i] & FLAG.SUBDIVIDED ? " · 구분소유" : "";
    row.innerHTML =
      `<div class="rk num">${r + 1}</div>` +
      `<div><div class="nm"></div><div class="meta num">${Math.round(state.D.area[i])}㎡ · ` +
      `${res.rooms[i]}실 · ${GRADE_LABELS[res.grade[i]]}등급${sub}</div></div>` +
      `<div class="yield num">${(res.s1[i] * 100).toFixed(2)}%</div>`;
    row.querySelector(".nm").textContent = state.nameOf(id) || id;
    row.addEventListener("click", () => selectParcel(id, true));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectParcel(id, true); }
    });
    frag.appendChild(row);
  });
  body.replaceChildren(frag);
}

function renderDetail(id) {
  const i = state.idx.get(id);
  const P = state.P;
  const el = $("detailBody");
  $("detailName").textContent = state.nameOf(id) || id;
  $("detail").hidden = false;
  document.body.classList.add("has-detail");

  if (i === undefined) {
    // scoring.json 에 없다 = 정적 필터에서 이미 걸린 필지
    el.innerHTML = `<div class="sect"><span class="tag warn">후보 제외</span>
      <div class="hint" style="margin-top:6px;color:var(--ink-3);font-size:12px">
      지목·용도지역·토지이용상황·접도 조건에서 제외된 필지입니다.</div></div>`;
    return;
  }
  const D = state.D, res = state.result;
  const f = financials(D.area[i], D.far[i], D.rf[i], D.price[i], D.demo[i], P);
  const rank = res.rankOf[i];
  const zone = state.zoneOf(id);

  const tags = [];
  if (D.flags[i] & FLAG.SUBDIVIDED) tags.push(`<span class="tag warn">구분소유 추정</span>`);
  if (D.flags[i] & FLAG.ZONE2) tags.push(`<span class="tag">용도지역 걸침</span>`);
  if (D.flags[i] & FLAG.ROAD_UNKNOWN) tags.push(`<span class="tag">도로측면 미지정</span>`);

  let head;
  if (res.isCand[i]) {
    head = `<div class="sect"><dl class="kv">
      <dt>순위</dt><dd><b>${rank.toLocaleString()}</b> / ${res.order.length.toLocaleString()}</dd>
      <dt>수익률</dt><dd><b>${(res.s1[i] * 100).toFixed(2)}%</b></dd>
      <dt>일조 개방도</dt><dd>${D.sun[i].toFixed(3)}</dd>
      <dt>역세권</dt><dd>${GRADE_LABELS[res.grade[i]]}등급 · ${Math.round(D.dist[i]).toLocaleString()}m</dd>
      </dl>${tags.join("")}</div>`;
  } else {
    const why = exclusionReasons(D.flags[i], f.rooms, P.min_rooms);
    const subEx = $("exSub").checked && D.flags[i] & FLAG.SUBDIVIDED;
    if (subEx) why.push("다세대(구분소유) 제외 설정");
    head = `<div class="sect"><span class="tag warn">후보 제외</span>
      <ul style="margin:7px 0 0;padding-left:17px;color:var(--ink-2);font-size:12px">
      ${why.map((w) => `<li>${w}</li>`).join("")}</ul></div>`;
  }

  el.innerHTML = head + `
    <div class="sect"><dl class="kv">
      <dt>용도지역</dt><dd>${zone}</dd>
      <dt>필지면적</dt><dd>${Math.round(D.area[i]).toLocaleString()}㎡</dd>
      <dt>적용용적률</dt><dd>${D.far[i]}%</dd>
      <dt>실현계수</dt><dd>${D.rf[i].toFixed(2)}</dd>
      <dt>가용연면적</dt><dd>${Math.round(f.gfa).toLocaleString()}㎡</dd>
      <dt>추정 실 수</dt><dd>${f.rooms.toLocaleString()}실</dd>
    </dl></div>
    <div class="sect"><dl class="kv">
      <dt>공시지가</dt><dd>${won(D.price[i])}원/㎡</dd>
      <dt>토지비</dt><dd>${won(f.land)}원</dd>
      <dt>공사비</dt><dd>${won(f.build)}원</dd>
      <dt>철거비</dt><dd>${f.demoCost > 0 ? won(f.demoCost) + "원" : "없음"}</dd>
      <dt>총사업비</dt><dd><b>${won(f.total)}원</b></dd>
      <dt>보증금</dt><dd>${won(f.deposit)}원</dd>
      <dt>연 NOI</dt><dd>${won(f.noi)}원</dd>
    </dl></div>`;
}

function selectParcel(id, fly) {
  state.selected = id;
  document.querySelectorAll("#listBody .row").forEach((r) =>
    r.setAttribute("aria-selected", r.dataset.id === id ? "true" : "false"));
  const sel = document.querySelector(`#listBody .row[aria-selected="true"]`);
  if (sel) sel.scrollIntoView({ block: "nearest" });
  for (const l of ["parcel-selected", "parcel-selected-casing"]) {
    state.map.setFilter(l, ["==", ["get", "id"], id]);
  }
  renderDetail(id);
  if (fly) {
    const fs = state.map.querySourceFeatures("parcels", {
      sourceLayer: "parcels", filter: ["==", ["get", "id"], id],
    });
    if (fs.length) {
      const b = new maplibregl.LngLatBounds();
      const add = (c) => Array.isArray(c[0]) ? c.forEach(add) : b.extend(c);
      fs.forEach((f) => add(f.geometry.coordinates));
      if (!b.isEmpty()) state.map.fitBounds(b, { padding: 220, maxZoom: 17.5, duration: 600 });
    }
  }
}

/* ── 부트 ──────────────────────────────────────────────── */
async function boot() {
  const setBoot = (t) => { $("bootText").textContent = t; };

  setBoot("설정을 읽는 중");
  const [meta, scoring] = await Promise.all([
    fetch("data/meta.json").then((r) => r.json()),
    fetch("data/scoring.json").then((r) => r.json()),
  ]);
  state.meta = meta;
  state.D = prepare(scoring, meta.scale);
  state.idx = new Map(state.D.ids.map((v, i) => [v, i]));

  // 기본값을 컨트롤에 주입 (params.yaml 이 단일 출처)
  const d = meta.defaults;
  $("tol1").value = d.tol_profitability_pct;
  $("tol2").value = d.tol_solar_pct;
  $("rent").value = Math.round(d.monthly_rent_per_room / 1e4);
  $("deposit").value = Math.round(d.deposit_per_room / 1e4);
  $("cc").value = Math.round(d.unit_construction_cost / 1e4);
  $("mult").value = Math.round(d.land_price_multiplier * 100);
  $("roomA").value = d.room_area_sqm;
  $("minRooms").value = d.min_rooms;
  for (const g of ["A", "B", "C", "D"]) $(`g${g}`).value = d.grades[g];
  syncLabels();

  setBoot("지도를 준비하는 중");
  const proto = new pmtiles.Protocol();
  maplibregl.addProtocol("pmtiles", proto.tile);
  const url = new URL("data/parcels.pmtiles", location.href).href;
  proto.add(new pmtiles.PMTiles(url));

  const map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
      sources: {
        osm: {
          type: "raster",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256, maxzoom: 19,
          attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        },
        parcels: { type: "vector", url: "pmtiles://" + url, promoteId: "id" },
      },
      layers: [{ id: "osm", type: "raster", source: "osm", paint: BASEMAP_PAINT() }],
    },
    center: SEOUNGBUK, zoom: 12.6, minZoom: 10, maxZoom: 18,
    attributionControl: { compact: true },
  });
  state.map = map;
  // 자동 테스트·캡처 스크립트에서 지도를 조작하기 위한 핸들
  window.__map = map;
  window.__state = state;
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-left");
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 96, unit: "metric" }), "bottom-left");

  await new Promise((res) => map.on("load", res));

  // 색상: 순위가 높을수록 진하다.
  // pct 는 recompute() 에서 sqrt 변환해 넣는다. 선형이면 상위 10%가 램프의
  // 1.2단계만 차지해 최상위 필지가 배경에 묻힌다.
  const rampExpr = ["interpolate", ["linear"], ["feature-state", "pct"]];
  RAMP.forEach((c, k) => rampExpr.push(k / (RAMP.length - 1), c));
  const isCand = ["boolean", ["feature-state", "cand"], false];

  // 레이어는 하나만 쓴다. MapLibre 는 `filter` 안에서 feature-state 를 허용하지
  // 않으므로(타일 파싱 시점에 평가) 후보/비후보 구분은 paint 로만 한다.
  map.addLayer({
    id: "parcel-fill", type: "fill", source: "parcels", "source-layer": "parcels",
    paint: {
      "fill-color": [
        "case", isCand,
        ["case", ["==", ["feature-state", "pct"], null], "#cde2fb", rampExpr],
        "#b9b9b3",
      ],
      // 비후보는 기본 투명. "제외 필지 표시" 토글이 0.42 로 올린다.
      "fill-opacity": fillOpacity(0),
    },
  });
  map.addLayer({
    id: "parcel-line", type: "line", source: "parcels", "source-layer": "parcels",
    minzoom: 15,
    paint: { "line-color": "#6b6b66", "line-width": 0.4, "line-opacity": 0.5 },
  });
  map.addLayer({
    id: "parcel-hover", type: "line", source: "parcels", "source-layer": "parcels",
    filter: ["==", ["get", "id"], ""],
    paint: { "line-color": "#0b0b0b", "line-width": 1.6 },
  });
  // 선택 강조는 두 겹으로. 흰 케이싱이 없으면 짙은 필지 위에서 선이 묻힌다.
  map.addLayer({
    id: "parcel-selected-casing", type: "line", source: "parcels", "source-layer": "parcels",
    filter: ["==", ["get", "id"], ""],
    paint: { "line-color": "#ffffff", "line-width": 6, "line-opacity": 0.9 },
  });
  map.addLayer({
    id: "parcel-selected", type: "line", source: "parcels", "source-layer": "parcels",
    filter: ["==", ["get", "id"], ""],
    paint: { "line-color": "#eb6834", "line-width": 2.8 },
  });

  setBoot("경계와 역 정보를 불러오는 중");
  const [bnd, stn] = await Promise.all([
    fetch("data/boundary.geojson").then((r) => r.json()),
    fetch("data/stations.geojson").then((r) => r.json()),
  ]);
  map.addSource("bnd", { type: "geojson", data: bnd });
  map.addLayer({
    id: "bnd-line", type: "line", source: "bnd",
    paint: { "line-color": "#52514e", "line-width": 1.6, "line-dasharray": [3, 2] },
  });
  map.addSource("stn", { type: "geojson", data: stn });
  map.addLayer({
    id: "stn-dot", type: "circle", source: "stn", minzoom: 12,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 3.2, 16, 6],
      "circle-color": "#1c5cab", "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.4,
    },
  });
  map.addLayer({
    id: "stn-label", type: "symbol", source: "stn", minzoom: 13.2,
    layout: {
      "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"],
      "text-size": 11, "text-offset": [0, 1.1], "text-anchor": "top",
      "text-allow-overlap": false,
    },
    paint: { "text-color": "#22221f", "text-halo-color": "#ffffff", "text-halo-width": 1.6 },
  });

  // 이름·용도지역은 scoring.json 에서 온다. 타일에서 긁으면 화면 밖 필지의
  // 이름을 못 찾아 리스트에 PNU 가 노출된다.
  state.nameOf = (id) => {
    const i = state.idx.get(id);
    return i === undefined ? state.tileNames.get(id) : state.D.names[i];
  };
  state.zoneOf = (id) => {
    const i = state.idx.get(id);
    return i === undefined ? "" : (meta.zone_codes[String(state.D.zones[i])] ?? "");
  };
  // 후보 밖 필지(정적 필터 탈락)는 scoring.json 에 없으므로 클릭 시 타일에서 받는다.
  state.tileNames = new Map();

  // 좌측이 상위(진함). RAMP 는 옅음->진함 순이므로 뒤집어서 그린다.
  $("legendRamp").style.background =
    `linear-gradient(90deg, ${RAMP.slice().reverse().join(",")})`;

  wireUI();
  const ms = recompute();
  console.info(`[dss] 최초 계산 ${ms.toFixed(0)}ms · 후보 ${state.result.order.length}`);
  $("boot").hidden = true;

  // 상호작용
  let hovered = "";
  map.on("mousemove", "parcel-fill", (e) => {
    const id = e.features[0]?.properties?.id;
    if (id && id !== hovered) {
      hovered = id;
      map.setFilter("parcel-hover", ["==", ["get", "id"], id]);
      map.getCanvas().style.cursor = "pointer";
    }
  });
  map.on("mouseleave", "parcel-fill", () => {
    hovered = "";
    map.setFilter("parcel-hover", ["==", ["get", "id"], ""]);
    map.getCanvas().style.cursor = "";
  });
  map.on("click", (e) => {
    const fs = map.queryRenderedFeatures(e.point, { layers: ["parcel-fill"] });
    if (fs.length) {
      const p = fs[0].properties;
      if (p.nm) state.tileNames.set(p.id, p.nm);
      selectParcel(p.id, false);
    }
  });
}

/* ── UI 배선 ───────────────────────────────────────────── */
function wireUI() {
  const inputs = ["tol1", "tol2", "rent", "deposit", "cc", "mult", "roomA",
    "denom", "minRooms", "gA", "gB", "gC", "gD", "exSub"];
  let timer = null;
  const onChange = (e) => {
    if (e?.target?.id?.startsWith("g")) enforceGradeOrder(e.target.id);
    syncLabels();
    document.body.classList.add("busy");
    clearTimeout(timer);
    timer = setTimeout(() => {
      recompute();
      document.body.classList.remove("busy");
    }, 60);
  };
  inputs.forEach((id) => {
    $(id).addEventListener("input", onChange);
    $(id).addEventListener("change", onChange);
  });

  $("showEx").addEventListener("change", (e) => {
    state.map.setPaintProperty("parcel-fill", "fill-opacity",
      fillOpacity(e.target.checked ? 0.42 : 0));
  });

  $("reset").addEventListener("click", () => {
    const d = state.meta.defaults;
    $("tol1").value = d.tol_profitability_pct;
    $("tol2").value = d.tol_solar_pct;
    $("rent").value = Math.round(d.monthly_rent_per_room / 1e4);
    $("deposit").value = Math.round(d.deposit_per_room / 1e4);
    $("cc").value = Math.round(d.unit_construction_cost / 1e4);
    $("mult").value = Math.round(d.land_price_multiplier * 100);
    $("roomA").value = d.room_area_sqm;
    $("minRooms").value = d.min_rooms;
    $("denom").value = "net_equity";
    for (const g of ["A", "B", "C", "D"]) $(`g${g}`).value = d.grades[g];
    $("exSub").checked = false;
    syncLabels();
    recompute();
  });

  $("detailClose").addEventListener("click", () => {
    $("detail").hidden = true;
    document.body.classList.remove("has-detail");
    state.selected = null;
    for (const l of ["parcel-selected", "parcel-selected-casing"]) {
      state.map.setFilter(l, ["==", ["get", "id"], ""]);
    }
    document.querySelectorAll("#listBody .row").forEach((r) =>
      r.setAttribute("aria-selected", "false"));
  });

  const applyTheme = (t) => {
    document.documentElement.dataset.theme = t;
    localStorage.setItem("dss-theme", t);
  };
  try {
    const saved = localStorage.getItem("dss-theme");
    applyTheme(saved || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  } catch { applyTheme("light"); }
  $("themeBtn").addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
    const m = state.map;
    if (m && m.getLayer("osm")) {
      const p = BASEMAP_PAINT();
      m.setPaintProperty("osm", "raster-opacity", p["raster-opacity"]);
      m.setPaintProperty("osm", "raster-saturation", p["raster-saturation"]);
      m.setPaintProperty("osm", "raster-brightness-max", p["raster-brightness-max"] ?? 1);
    }
  });

  // 모바일은 지도가 먼저 보여야 한다. 파라미터는 접은 채로 시작.
  if (matchMedia("(max-width: 900px)").matches) {
    $("params").dataset.collapsed = "true";
    const btn = document.querySelector('[data-collapse="params"]');
    if (btn) btn.textContent = "\u25b8";
  }
  document.querySelectorAll("[data-collapse]").forEach((b) => {
    b.addEventListener("click", () => {
      const p = $(b.dataset.collapse);
      const now = p.dataset.collapsed === "true";
      p.dataset.collapsed = String(!now);
      b.textContent = now ? "▾" : "▸";
    });
  });
  $("togglePanels").addEventListener("click", () => {
    const hide = $("params").style.display !== "none";
    for (const id of ["params", "list"]) $(id).style.display = hide ? "none" : "";
  });

  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("detail").hidden) $("detailClose").click();
  });
}

boot().catch((err) => {
  console.error(err);
  $("bootText").innerHTML =
    `데이터를 불러오지 못했습니다.<br><span style="color:var(--ink-3);font-size:12px">${err.message}</span>`;
  document.querySelector("#boot .bar").style.display = "none";
});
