/* 지도 + 파라미터 UI. 점수 계산은 전부 score.js 가 한다. */

import {
  prepare, computeRanking, financials, exclusionReasons,
  assemble, connectivity, ringIntersectsPolygon,
  pickHubs, minSpacing, siteCenter, virtualRank,
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
// 성북구·성동구를 함께 담는 중심점
const REGION_CENTER = [127.0290, 37.5800];

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
  asm: [], geomCache: new Map(),
  draw: { on: false, pts: [], poly: null, inArea: null },
  sites: [],          // 거점. 단일 필지 또는 합필 묶음
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
  $("hubNv").textContent = $("hubN").value;
  $("hubDv").textContent = (+$("hubD").value).toLocaleString();
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
  const res = computeRanking(state.D, P, {
    excludeSubdivided: $("exSub").checked,
    onlySgg: $("sggSel").value,
    inArea: state.draw.inArea,
  });
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
  if (state.asm.length) renderAsm();
  if (state.sites.length) renderHub();
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
  if (!$("asm").hidden && !$("asmMode").checked) {
    $("asm").hidden = true;
    document.body.classList.remove("has-asm");
  }

  if (i === undefined) {
    // scoring.json 에 없다 = 정적 필터에서 이미 걸린 필지
    el.innerHTML = `<div class="sect"><span class="tag warn">후보 제외</span>
      <div class="hint" style="margin-top:6px;color:var(--ink-3);font-size:12px">
      지목·용도지역·토지이용상황·접도 조건에서 제외된 필지입니다.</div></div>`;
    return;
  }
  const D = state.D, res = state.result;
  const f = financials(D.area[i], D.far[i], D.rf[i], D.price[i], D.demo[i], P, D.ri[i]);
  const rank = res.rankOf[i];
  const zone = state.zoneOf(id);

  const tags = [];
  if (D.flags[i] & FLAG.SUBDIVIDED) tags.push(`<span class="tag warn">구분소유 추정</span>`);
  if (D.flags[i] & FLAG.INDUSTRIAL) tags.push(`<span class="tag warn">준공업·공업지역</span>`);
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

  const canHub = res.isCand[i];
  el.innerHTML = head + (canHub
    ? `<div class="sect"><button class="btn" id="detailHub">이 필지를 거점으로 담기</button></div>`
    : "") + `
    <div class="sect"><dl class="kv">
      <dt>용도지역</dt><dd>${zone}</dd>
      <dt>필지면적</dt><dd>${Math.round(D.area[i]).toLocaleString()}㎡</dd>
      <dt>적용용적률</dt><dd>${D.far[i]}%</dd>
      <dt>실현계수</dt><dd>${D.rf[i].toFixed(2)}</dd>
      <dt>가용연면적</dt><dd>${Math.round(f.gfa).toLocaleString()}㎡</dd>
      <dt>추정 실 수</dt><dd>${f.rooms.toLocaleString()}실</dd>
    </dl></div>
    <div class="sect"><dl class="kv">
      <dt>적용 임대료</dt><dd>${Math.round(f.rent / 1e4).toLocaleString()}만원/월
        <span style="color:var(--ink-3)">(지수 ${D.ri[i].toFixed(2)})</span></dd>
      <dt>공시지가</dt><dd>${won(D.price[i])}원/㎡</dd>
      <dt>토지비</dt><dd>${won(f.land)}원</dd>
      <dt>공사비</dt><dd>${won(f.build)}원</dd>
      <dt>철거비</dt><dd>${f.demoCost > 0 ? won(f.demoCost) + "원" : "없음"}</dd>
      <dt>총사업비</dt><dd><b>${won(f.total)}원</b></dd>
      <dt>보증금</dt><dd>${won(f.deposit)}원</dd>
      <dt>연 NOI</dt><dd>${won(f.noi)}원</dd>
    </dl></div>`;

  const hb = $("detailHub");
  if (hb) hb.addEventListener("click", () => {
    if (addSite([i])) hb.textContent = "거점에 담았습니다";
    else hb.textContent = "이미 담긴 거점입니다";
  });
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

/* ── 합필 ──────────────────────────────────────────────── */

/** 위경도 → 대략적 미터 좌표 (선택 영역 중심 기준 등거리 근사) */
function toMeters(coords, lat0, lon0) {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  return coords.map(([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * 110540]);
}

/** 타일에서 필지 꼭짓점을 긁어 캐시한다. 나중에 화면 밖으로 나가도 계산할 수 있게. */
function cacheGeom(id) {
  if (state.geomCache.has(id)) return;
  const fs = state.map.querySourceFeatures("parcels", {
    sourceLayer: "parcels", filter: ["==", ["get", "id"], id],
  });
  const pts = [];
  const walk = (c) => (Array.isArray(c[0]) ? c.forEach(walk) : pts.push(c));
  fs.forEach((f) => walk(f.geometry.coordinates));
  if (pts.length) state.geomCache.set(id, pts);
}

/** 타일 로드가 늦으면 도형을 못 얻는다. 빠진 것만 다시 채우고, 채워지면 다시 그린다. */
function fillMissingGeom() {
  if (!state.asm.length) return;
  let added = 0;
  for (const i of state.asm) {
    const id = state.D.ids[i];
    if (state.geomCache.has(id)) continue;
    cacheGeom(id);
    if (state.geomCache.has(id)) added++;
  }
  if (added) renderAsm();
}

function asmToggle(id) {
  const i = state.idx.get(id);
  if (i === undefined) return false;          // 정적 필터 탈락 필지는 합필 불가
  const at = state.asm.indexOf(i);
  if (at >= 0) state.asm.splice(at, 1);
  else { state.asm.push(i); cacheGeom(id); }
  renderAsm();
  paintAsm();
  return true;
}

function paintAsm() {
  const ids = state.asm.map((i) => state.D.ids[i]);
  state.map.setFilter("parcel-asm", ["in", ["get", "id"], ["literal", ids]]);
  state.map.setFilter("parcel-asm-line", ["in", ["get", "id"], ["literal", ids]]);
}

function renderAsm() {
  const el = $("asmBody");
  const P = state.P;
  const A = state.meta.assembly;
  $("asmCount").textContent = state.asm.length ? String(state.asm.length) : "";
  if (!state.asm.length) {
    $("asm").hidden = !$("asmMode").checked;
    document.body.classList.toggle("has-asm", !$("asm").hidden);
    el.innerHTML = `<div class="empty">지도에서 필지를 눌러 담으세요.<br>
      규모 미달 필지도 담을 수 있습니다.</div>`;
    return;
  }
  $("asm").hidden = false;

  const D = state.D;
  const items = state.asm.map((i) => ({
    area: D.area[i], far: D.far[i], tf: D.tf[i], rf: D.rf[i],
    price: D.price[i], demo: D.demo[i], sun: D.sun[i], dist: D.dist[i], ri: D.ri[i],
    flags: D.flags[i], zone: state.zoneOf(D.ids[i]),
  }));

  // 합필 폴리곤 꼭짓점 (미터 좌표)
  let hull = null;
  const all = [];
  let have = 0;
  for (const i of state.asm) {
    const pts = state.geomCache.get(D.ids[i]);
    if (pts) { all.push(...pts); have++; }
  }
  if (have === state.asm.length && all.length >= 3) {
    const lat0 = all.reduce((s, p) => s + p[1], 0) / all.length;
    const lon0 = all.reduce((s, p) => s + p[0], 0) / all.length;
    hull = toMeters(all, lat0, lon0);
  }

  const m = assemble(items, hull, P, A);
  window.__lastAsm = m;
  const groups = connectivity(state.asm, D.adj);
  const soloBest = Math.max(...state.asm.map((i) => state.result.s1[i] || -Infinity));
  const soloCand = state.asm.filter((i) => state.result.isCand[i]).length;
  const isInd = items.some((x) => A.industrial_zones.includes(x.zone));
  const needPlan = isInd && m.area >= A.district_plan_threshold_sqm;

  const rows = state.asm.map((i) => {
    const id = D.ids[i];
    return `<div class="pill"><span class="nm">${state.nameOf(id) || id}</span>` +
      `<span class="a">${Math.round(D.area[i]).toLocaleString()}㎡</span>` +
      `<button data-rm="${id}" aria-label="빼기">✕</button></div>`;
  }).join("");

  const conn = groups.length === 1
    ? `<div class="note">연접 확인. <b>1개 필지로 합필 가능</b>합니다.</div>`
    : `<div class="note warn">연접이 끊깁니다. <b>${groups.length}개 덩어리</b>
        (${groups.map((g) => g.length).join(" + ")}필지)로 나뉩니다.
        합필은 맞닿아야 하므로 도로 건너편은 <b>별동</b>으로 지어야 합니다.
        아래 수치는 한 덩어리로 가정한 값이라 참고용입니다.</div>`;

  const plan = needPlan
    ? `<div class="note warn">준공업지역 부지가 ${Math.round(m.area).toLocaleString()}㎡ 로
        <b>3,000㎡ 이상</b>입니다. 공동주택 지구단위계획 수립 의무가 생깁니다 (수년 소요).</div>`
    : "";

  const gain = m.s1 - soloBest;
  const gainTxt = Number.isFinite(gain)
    ? `<span class="delta" style="color:${gain >= 0 ? "var(--good)" : "var(--warn)"}">
        단독 최고 대비 ${(gain * 100).toFixed(2)}%p</span>` : "";

  el.innerHTML = `
    <div class="sect">${rows}</div>
    <div class="sect">
      <div class="big">${m.rooms.toLocaleString()}실 · ${(m.s1 * 100).toFixed(2)}%</div>
      ${gainTxt}
      <dl class="kv" style="margin-top:8px">
        <dt>필지 수</dt><dd>${m.n}필지 (단독 후보 ${soloCand})</dd>
        <dt>합산 면적</dt><dd>${Math.round(m.area).toLocaleString()}㎡</dd>
        <dt>적용용적률</dt><dd>${m.far.toFixed(0)}%</dd>
        <dt>적용 임대료</dt><dd>${Math.round(P.monthly_rent_per_room * m.ri / 1e4)}만원/월
          <span style="color:var(--ink-3)">(지수 ${m.ri.toFixed(2)})</span></dd>
        <dt>실현계수</dt><dd>${m.rf.toFixed(2)}${m.exact ? "" : " (근사)"}</dd>
        <dt>가용연면적</dt><dd>${Math.round(m.gfa).toLocaleString()}㎡</dd>
        <dt>총사업비</dt><dd><b>${won(m.total)}원</b></dd>
        <dt>실당 사업비</dt><dd>${won(m.total / Math.max(m.rooms, 1))}원</dd>
        <dt>최근접역</dt><dd>${Math.round(m.dist).toLocaleString()}m</dd>
      </dl>
    </div>
    <div class="sect"><button class="btn" id="asmHub">이 합필을 거점으로 담기</button></div>
    ${conn}${plan}
    <div class="note">실 수·수익률은 타일 도형으로 계산합니다. 좌표가 격자에 스냅되어
      <b>실 수 기준 ±2%</b> 정도 오차가 있을 수 있습니다.${m.exact ? "" :
      " 지금은 필지 도형을 못 읽어 <b>근사값</b>입니다. 해당 필지가 화면에 보이면 정확해집니다."}</div>`;

  el.querySelectorAll("[data-rm]").forEach((b) =>
    b.addEventListener("click", () => asmToggle(b.dataset.rm)));
  const ab = $("asmHub");
  if (ab) ab.addEventListener("click", () => {
    // 합필 도형을 함께 저장한다. 나중에 화면 밖으로 나가도 실현계수가 정확하다.
    const ok = addSite(state.asm, hull);
    ab.textContent = ok ? "거점에 담았습니다" : "이미 담긴 거점입니다";
  });
}

/* ── 거점 네트워크 ───────────────────────────────────────
 * 거점 = 단일 필지 또는 합필 묶음.
 * 단일 필지 최적화 결과를 그대로 쓰면 한 블록에 몰리므로 최소 이격을 건다.
 * ───────────────────────────────────────────────────── */

let siteSeq = 0;

/** 사이트 하나의 지표. 합필이면 assemble(), 단일이면 financials(). */
function siteMetrics(site) {
  const D = state.D, P = state.P, res = state.result;
  if (site.indices.length === 1) {
    const i = site.indices[0];
    const f = financials(D.area[i], D.far[i], D.rf[i], D.price[i], D.demo[i], P, D.ri[i]);
    return {
      rooms: f.rooms, s1: f.s1, cost: f.total, area: D.area[i],
      sun: D.sun[i], dist: D.dist[i], grade: res.grade[i],
      rank: res.rankOf[i] || null, virtual: false,
    };
  }
  const items = site.indices.map((i) => ({
    area: D.area[i], far: D.far[i], tf: D.tf[i], rf: D.rf[i],
    price: D.price[i], demo: D.demo[i], sun: D.sun[i], dist: D.dist[i],
    ri: D.ri[i], zone: state.zoneOf(D.ids[i]),
  }));
  const hull = site.hull || null;
  const m = assemble(items, hull, P, state.meta.assembly);
  const grade = gradeFromDist(m.dist, P.grades);
  return {
    rooms: m.rooms, s1: m.s1, cost: m.total, area: m.area,
    sun: m.sun, dist: m.dist, grade,
    // 합필은 후보 목록에 없다. 단일 필지들 사이에서 몇 위에 해당하는지 계산한다.
    rank: virtualRank(m.s1, m.sun, grade, res, D, P), virtual: true,
    zones: items.map((x) => x.zone),
  };
}

function gradeFromDist(d, g) {
  return d <= g.A ? 0 : d <= g.B ? 1 : d <= g.C ? 2 : d <= g.D ? 3 : 4;
}

function addSite(indices, hull) {
  const key = indices.slice().sort((a, b) => a - b).join(",");
  if (state.sites.some((s) => s.key === key)) return false;
  state.sites.push({ id: ++siteSeq, key, indices: indices.slice(), hull: hull || null });
  renderHub();
  paintHubs();
  return true;
}

function removeSite(id) {
  state.hubTried = false;
  state.sites = state.sites.filter((s) => s.id !== id);
  renderHub();
  paintHubs();
}

// 역 라벨 배치. 심볼 레이어가 해 주던 일(줌 하한·뷰포트 컬링·겹침 회피)을 대신한다.
const STN_MIN_ZOOM = 13.2;
function placeStnLabels() {
  const map = state.map;
  if (!map || !state.stnLabels) return;
  const on = map.getZoom() >= STN_MIN_ZOOM;
  const { width, height } = map.getCanvas().getBoundingClientRect();
  const placed = [];
  for (const mk of state.stnLabels) {
    const el = mk.getElement();
    if (!on) { el.style.display = "none"; continue; }
    const p = map.project(mk.getLngLat());
    // 화면 밖이면 배치 계산에서 빼 준다 (역 89개 × 이동마다이므로 값싸야 한다)
    if (p.x < -60 || p.y < -20 || p.x > width + 60 || p.y > height + 30) {
      el.style.display = "none";
      continue;
    }
    // 겹치면 뒤에 오는 쪽을 숨긴다 (symbol 의 text-allow-overlap:false 와 같은 규칙)
    const hit = placed.some((q) => Math.abs(q.x - p.x) < 54 && Math.abs(q.y - p.y) < 15);
    el.style.display = hit ? "none" : "";
    if (!hit) placed.push(p);
  }
}

function paintHubs() {
  const ids = state.sites.flatMap((s) => s.indices.map((i) => state.D.ids[i]));
  for (const l of ["parcel-hub", "parcel-hub-line"]) {
    state.map.setFilter(l, ["in", ["get", "id"], ["literal", ids]]);
  }
  // 거점 번호 핀. 자치구 전체 축척에서 필지 폴리곤은 몇 픽셀이라 보이지 않는다.
  // 심볼 레이어는 basemap 글리프 폰트스택에 없는 이름을 쓰면 pbf 파싱이 깨지면서
  // 같은 렌더 패스의 원 레이어까지 사라진다(실제로 발생). HTML 마커는 폰트 의존이 없다.
  const D = state.D;
  for (const m of state.hubPins || []) m.remove();
  state.hubPins = state.sites.map((s, k) => {
    // 핀 좌표는 WGS84 가 필요하다. cx/cy 는 EPSG:5186 이므로 면적가중 lon/lat 로 따로 낸다.
    let x = 0, y = 0, a = 0;
    for (const i of s.indices) { x += D.lon[i] * D.area[i]; y += D.lat[i] * D.area[i]; a += D.area[i]; }
    const el = document.createElement("button");
    el.className = "hubpin";
    el.textContent = String(k + 1);
    el.title = s._nm || "";
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      document.getElementById(`site-${s.id}`)?.scrollIntoView({ block: "nearest" });
    });
    return new maplibregl.Marker({ element: el })
      .setLngLat([x / a, y / a]).addTo(state.map);
  });
}

function hubAuto() {
  const P = state.P, D = state.D;
  const n = +$("hubN").value;
  const minD = +$("hubD").value;
  // 이미 담은 거점(합필 포함)은 유지하고 나머지를 채운다
  const fixed = state.sites.map((s) => siteCenter(s.indices, D));
  const used = new Set(state.sites.flatMap((s) => s.indices));
  const order = state.result.order.filter((i) => !used.has(i));
  const picked = pickHubs(order, D, { n, minDist: minD, fixed });
  for (const i of picked) addSite([i]);
  state.hubTried = true;
  if (!state.sites.length) return;
  renderHub();
}

function renderHub() {
  const el = $("hubBody");
  $("hubCount").textContent = state.sites.length ? String(state.sites.length) : "";
  if (!state.sites.length) {
    $("hub").hidden = true;
    return;
  }
  $("hub").hidden = false;
  const D = state.D;

  const rows = state.sites.map((s, k) => {
    const m = siteMetrics(s);
    s._m = m;
    const nm = s.indices.length === 1
      ? (state.nameOf(D.ids[s.indices[0]]) || D.ids[s.indices[0]])
      : `${state.nameOf(D.ids[s.indices[0]]) || ""} 외 ${s.indices.length - 1}필지 합필`;
    s._nm = nm;                     // 지도 핀 툴팁이 같은 이름을 쓴다
    const rk = m.rank
      ? `${m.rank.toLocaleString()}위${m.virtual ? " 상당" : ""}`
      : "순위 밖";
    return `<div class="site" id="site-${s.id}">
      <span class="no">${k + 1}</span>
      <div><div class="nm"></div><div class="meta num">${Math.round(m.area).toLocaleString()}㎡ ·
        ${m.rooms}실 · ${GRADE_LABELS[m.grade]}등급 ${Math.round(m.dist).toLocaleString()}m · ${rk}</div></div>
      <span class="y">${(m.s1 * 100).toFixed(2)}%</span>
      <button data-site="${s.id}" aria-label="빼기">✕</button>
    </div>`;
  }).join("");

  const rooms = state.sites.reduce((a, s) => a + s._m.rooms, 0);
  const cost = state.sites.reduce((a, s) => a + s._m.cost, 0);
  const wS1 = state.sites.reduce((a, s) => a + s._m.s1 * s._m.cost, 0) / (cost || 1);
  const centers = state.sites.map((s) => siteCenter(s.indices, D));
  const spacing = minSpacing(centers);
  const dongs = new Set(state.sites.map((s) =>
    (state.nameOf(D.ids[s.indices[0]]) || "").split(" ").slice(0, 2).join(" ")));

  const spacingNote = spacing === null ? ""
    : spacing < 500
      ? `<div class="note warn">거점이 <b>${Math.round(spacing).toLocaleString()}m</b> 밖에
         안 떨어져 있습니다. 같은 수요를 나눠 먹고 커버리지도 겹칩니다.
         최소 이격거리를 올려 다시 선정해 보세요.</div>`
      : `<div class="note">최근접 거점 간 <b>${Math.round(spacing).toLocaleString()}m</b>.
         ${dongs.size}개 지역에 분산돼 있습니다.</div>`;

  // 이격을 크게 잡으면 요청한 수를 못 채운다. 조용히 적게 주지 않고 이유를 말한다.
  const want = +$("hubN").value, got = state.sites.length;
  const shortNote = state.hubTried && got < want
    ? `<div class="note warn">이격 <b>${(+$("hubD").value).toLocaleString()}m</b> 조건으로는
       ${want}곳을 채울 수 없어 <b>${got}곳</b>만 선정했습니다.
       이격을 줄이거나 거점 수를 낮추세요.</div>`
    : "";

  el.innerHTML = rows + shortNote + `
    <div class="tot">
      <div class="big">${rooms.toLocaleString()}실 · ${(cost / 1e8).toFixed(0)}억</div>
      <dl class="kv" style="margin-top:7px">
        <dt>거점 수</dt><dd>${state.sites.length}곳
          (합필 ${state.sites.filter((s) => s.indices.length > 1).length})</dd>
        <dt>가중 평균 수익률</dt><dd><b>${(wS1 * 100).toFixed(2)}%</b></dd>
        <dt>실당 사업비</dt><dd>${won(cost / Math.max(rooms, 1))}원</dd>
      </dl>
    </div>${spacingNote}`;

  el.querySelectorAll(".site").forEach((row, k) => {
    const s = state.sites[k];
    row.querySelector(".nm").textContent = s.indices.length === 1
      ? (state.nameOf(D.ids[s.indices[0]]) || D.ids[s.indices[0]])
      : `${state.nameOf(D.ids[s.indices[0]]) || ""} 외 ${s.indices.length - 1}필지 합필`;
    s._nm = row.querySelector(".nm").textContent;   // 지도 핀 툴팁이 같은 이름을 쓴다
  });
  el.querySelectorAll("[data-site]").forEach((b) =>
    b.addEventListener("click", () => removeSite(+b.dataset.site)));
}

/* ── 범위 그리기 ─────────────────────────────────────────
 * 카카오맵·네이버맵의 반경/면적 그리기와 같은 조작감:
 * 클릭으로 꼭짓점을 찍고 더블클릭(또는 Enter)으로 닫는다.
 * 판정은 **교차**다. 폴리곤 경계에 걸치는 필지도 범위에 포함한다.
 * ───────────────────────────────────────────────────── */

function drawRender() {
  const d = state.draw;
  const pts = d.pts;
  const line = pts.length >= 2
    ? [{ type: "Feature", geometry: { type: "LineString", coordinates: d.on ? pts : [...pts, pts[0]] } }]
    : [];
  const fill = d.poly
    ? [{ type: "Feature", geometry: { type: "Polygon", coordinates: [[...d.poly, d.poly[0]]] } }]
    : [];
  const dots = pts.map((p) => ({ type: "Feature", geometry: { type: "Point", coordinates: p } }));
  state.map.getSource("draw-line").setData({ type: "FeatureCollection", features: line });
  state.map.getSource("draw-fill").setData({ type: "FeatureCollection", features: fill });
  state.map.getSource("draw-pt").setData({ type: "FeatureCollection", features: dots });
}

/** 폴리곤에 걸치는 필지 인덱스 집합. 필지 링은 타일에서 가져온다. */
function computeInArea(poly) {
  const set = new Set();
  const bb = poly.reduce((b, p) => [
    Math.min(b[0], p[0]), Math.min(b[1], p[1]),
    Math.max(b[2], p[0]), Math.max(b[3], p[1]),
  ], [Infinity, Infinity, -Infinity, -Infinity]);

  const feats = state.map.querySourceFeatures("parcels", { sourceLayer: "parcels" });
  let seen = 0;
  for (const f of feats) {
    const id = f.properties?.id;
    if (!id) continue;
    const i = state.idx.get(id);
    if (i === undefined || set.has(i)) continue;
    const rings = [];
    const walk = (c) => {
      if (typeof c[0][0] === "number") rings.push(c);
      else c.forEach(walk);
    };
    walk(f.geometry.coordinates);
    for (const r of rings) {
      // 바운딩박스로 먼저 거른다
      let ok = false;
      for (const p of r) {
        if (p[0] >= bb[0] && p[0] <= bb[2] && p[1] >= bb[1] && p[1] <= bb[3]) { ok = true; break; }
      }
      if (!ok && !poly.some((p) => {
        const xs = r.map((q) => q[0]), ys = r.map((q) => q[1]);
        return p[0] >= Math.min(...xs) && p[0] <= Math.max(...xs)
            && p[1] >= Math.min(...ys) && p[1] <= Math.max(...ys);
      })) continue;
      if (ringIntersectsPolygon(r, poly)) { set.add(i); break; }
    }
    seen++;
  }
  return { set, seen };
}

/** 더블클릭은 click 두 번을 먼저 발생시킨다. 같은 자리에 겹친 꼭짓점을 걷어낸다. */
function dedupeTail(pts, tol = 2e-5) {
  const out = pts.slice();
  while (out.length >= 2) {
    const a = out[out.length - 1], b = out[out.length - 2];
    if (Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol) out.pop();
    else break;
  }
  return out;
}

function drawFinish() {
  const d = state.draw;
  d.pts = dedupeTail(d.pts);
  if (d.pts.length < 3) { drawCancel(); return; }
  d.poly = d.pts.slice();
  d.on = false;
  document.body.classList.remove("drawing");
  $("drawBtn").setAttribute("aria-pressed", "false");
  $("drawBtn").textContent = "범위 다시 그리기";
  $("drawClear").disabled = false;

  const { set, seen } = computeInArea(d.poly);
  d.inArea = set;
  $("drawHint").innerHTML = set.size
    ? `범위 안 필지 <b>${set.size.toLocaleString()}</b>개 (화면에 로드된 ${seen.toLocaleString()}개 중).
       <b>경계에 걸치는 필지도 포함</b>됩니다. 줌아웃 상태면 일부 타일이 안 읽혀 누락될 수 있으니
       범위가 다 보이는 축척에서 그리세요.`
    : `범위 안에 필지가 없습니다. 축척을 키우고 다시 그려 보세요.`;
  drawRender();
  recompute();
}

function drawCancel() {
  const d = state.draw;
  d.on = false; d.pts = []; d.poly = null; d.inArea = null;
  document.body.classList.remove("drawing");
  $("drawBtn").setAttribute("aria-pressed", "false");
  $("drawBtn").textContent = "범위 그리기";
  $("drawClear").disabled = true;
  $("drawHint").innerHTML =
    "지도를 클릭해 꼭짓점을 찍고, 더블클릭 또는 Enter 로 닫습니다. <b>폴리곤에 걸치는 필지도 포함</b>됩니다.";
  drawRender();
  recompute();
}

function drawStart() {
  const d = state.draw;
  d.on = true; d.pts = []; d.poly = null; d.inArea = null;
  document.body.classList.add("drawing");
  $("drawBtn").setAttribute("aria-pressed", "true");
  $("drawBtn").textContent = "그리는 중 (Esc 취소)";
  $("drawClear").disabled = false;
  $("drawHint").innerHTML = "꼭짓점을 클릭하세요. <b>더블클릭 또는 Enter</b> 로 닫습니다.";
  drawRender();
  recompute();
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

  // 자치구 선택지는 meta.json 이 단일 출처
  const sel = $("sggSel");
  for (const dd of meta.districts || []) {
    const o = document.createElement("option");
    o.value = dd.code; o.textContent = dd.name;
    sel.appendChild(o);
  }
  $("hdrSub").textContent =
    `${(meta.districts || []).map((x) => x.name).join(" · ")} `
    + `${(meta.parcel_count || 0).toLocaleString()} 필지`;
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
      // glyphs 를 두지 않는다. 심볼 레이어가 하나도 없기 때문이다.
      // fonts.openmaptiles.org 는 없는 폰트에 404 가 아니라 200 + HTML 을 돌려준다.
      // MapLibre 는 그 HTML 을 pbf 로 파싱하다 "Unimplemented type: 4" 로 죽고,
      // 같은 렌더 패스의 다른 레이어까지 사라진다. 라벨은 HTML 마커로 그린다.
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
    center: REGION_CENTER, zoom: 12.0, minZoom: 9.5, maxZoom: 18,
    attributionControl: { compact: true },
  });
  state.map = map;
  // 자동 테스트·캡처 스크립트에서 지도를 조작하기 위한 핸들
  window.__map = map;
  window.__state = state;
  window.__asmToggle = asmToggle;   // 자동 테스트에서 합필 담기를 호출한다
  window.__renderAsm = renderAsm;
  window.__cacheGeom = cacheGeom;
  window.__selectParcel = selectParcel;   // 목록 밖 필지도 캡처·테스트에서 열 수 있게
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
    id: "parcel-hub", type: "fill", source: "parcels", "source-layer": "parcels",
    filter: ["in", ["get", "id"], ["literal", []]],
    paint: { "fill-color": "#0ca30c", "fill-opacity": 0.45 },
  });
  map.addLayer({
    id: "parcel-hub-line", type: "line", source: "parcels", "source-layer": "parcels",
    filter: ["in", ["get", "id"], ["literal", []]],
    paint: { "line-color": "#0a7d0a", "line-width": 2 },
  });
  map.addLayer({
    id: "parcel-asm", type: "fill", source: "parcels", "source-layer": "parcels",
    filter: ["in", ["get", "id"], ["literal", []]],
    paint: { "fill-color": "#eb6834", "fill-opacity": 0.42 },
  });
  map.addLayer({
    id: "parcel-asm-line", type: "line", source: "parcels", "source-layer": "parcels",
    filter: ["in", ["get", "id"], ["literal", []]],
    paint: { "line-color": "#eb6834", "line-width": 1.8 },
  });
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
  // 자치구별 경계 bbox — 필터 시 지도 이동에 쓴다
  state.bndByCode = {};
  for (const f of bnd.features) {
    const bb = new maplibregl.LngLatBounds();
    const add = (c) => (Array.isArray(c[0]) ? c.forEach(add) : bb.extend(c));
    add(f.geometry.coordinates);
    state.bndByCode[String(f.properties.sgg_cd)] = bb;
  }

  map.addSource("bnd", {
    type: "geojson", data: bnd,
    // CC BY 4.0 표기 의무. 지도 attribution 에도 남긴다.
    attribution: '경계: 통계청 SGIS (가공 <a href="https://github.com/vuski/admdongkor" target="_blank" rel="noopener">vuski/admdongkor</a>, CC BY 4.0) · 필지·건물: 국토교통부',
  });
  map.addLayer({
    id: "bnd-line", type: "line", source: "bnd",
    paint: { "line-color": "#52514e", "line-width": 1.6, "line-dasharray": [3, 2] },
  });
  for (const id of ["draw-fill", "draw-line", "draw-pt"]) {
    map.addSource(id, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  }
  map.addLayer({
    id: "draw-fill", type: "fill", source: "draw-fill",
    paint: { "fill-color": "#eb6834", "fill-opacity": 0.10 },
  });
  map.addLayer({
    id: "draw-line", type: "line", source: "draw-line",
    paint: { "line-color": "#eb6834", "line-width": 2, "line-dasharray": [2, 1.5] },
  });
  map.addLayer({
    id: "draw-pt", type: "circle", source: "draw-pt",
    paint: {
      "circle-radius": 4.5, "circle-color": "#ffffff",
      "circle-stroke-color": "#eb6834", "circle-stroke-width": 2,
    },
  });

  map.addSource("stn", { type: "geojson", data: stn });
  map.addLayer({
    id: "stn-dot", type: "circle", source: "stn", minzoom: 12,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 3.2, 16, 6],
      "circle-color": "#1c5cab", "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.4,
    },
  });
  // 역 이름은 HTML 마커로 그린다. 심볼 레이어를 쓰면 글리프를 받아야 하는데,
  // 그 의존이 조용히 끊기면 라벨이 사라지는 정도가 아니라 렌더 패스가 통째로 죽는다.
  state.stnLabels = stn.features.map((f) => {
    const el = document.createElement("span");
    el.className = "stnlabel";
    el.textContent = f.properties.name;
    el.setAttribute("aria-hidden", "true");   // 지도 밖 목록·상세에 같은 정보가 있다
    return new maplibregl.Marker({ element: el, anchor: "top", offset: [0, 6] })
      .setLngLat(f.geometry.coordinates).addTo(map);
  });
  placeStnLabels();
  map.on("moveend", placeStnLabels);
  map.on("zoomend", placeStnLabels);

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
  map.on("idle", fillMissingGeom);

  // 상호작용
  let hovered = "";
  map.on("dblclick", (e) => {
    if (!state.draw.on) return;
    e.preventDefault();
    drawFinish();
  });
  map.doubleClickZoom.disable();
  map.on("load", () => map.doubleClickZoom.enable());

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
    if (state.draw.on) {
      // 즉시 찍는다 (반응이 바로 보여야 한다). 더블클릭이 만드는 중복 꼭짓점은
      // 닫을 때 걸러낸다 (dedupeTail).
      state.draw.pts.push([e.lngLat.lng, e.lngLat.lat]);
      drawRender();
      return;
    }
    const fs = map.queryRenderedFeatures(e.point, { layers: ["parcel-fill"] });
    if (!fs.length) return;
    const p = fs[0].properties;
    if (p.nm) state.tileNames.set(p.id, p.nm);
    if ($("asmMode").checked) {
      if (!asmToggle(p.id)) selectParcel(p.id, false);
      return;
    }
    selectParcel(p.id, false);
  });
}

/* ── UI 배선 ───────────────────────────────────────────── */
function wireUI() {
  const inputs = ["tol1", "tol2", "rent", "deposit", "cc", "mult", "roomA",
    "denom", "minRooms", "gA", "gB", "gC", "gD", "exSub", "sggSel"];
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

  $("sggSel").addEventListener("change", () => {
    const code = $("sggSel").value;
    if (code === "0" || !state.bndByCode) return;
    const b = state.bndByCode[code];
    if (b) state.map.fitBounds(b, { padding: 60, duration: 700 });
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
    $("sggSel").value = "0";
    $("hubN").value = 5;
    $("hubD").value = state.meta.hubs?.default_min_spacing_m ?? 1000;
    syncLabels();
    if (state.draw.poly || state.draw.on) drawCancel();
    else recompute();
  });

  const aboutOpen = (v) => {
    $("about").hidden = !v;
    $("aboutBtn").setAttribute("aria-expanded", String(v));
  };
  $("aboutBtn").addEventListener("click", () => aboutOpen($("about").hidden));
  $("aboutClose").addEventListener("click", () => aboutOpen(false));

  for (const id of ["hubN", "hubD"]) $(id).addEventListener("input", syncLabels);
  $("hubAuto").addEventListener("click", hubAuto);
  $("hubClear").addEventListener("click", () => {
    state.sites = [];
    paintHubs();
    renderHub();
  });
  $("hubClose").addEventListener("click", () => { $("hub").hidden = true; });

  $("drawBtn").addEventListener("click", () => {
    if (state.draw.on) drawFinish();
    else drawStart();
  });
  $("drawClear").addEventListener("click", drawCancel);

  $("asmMode").addEventListener("change", (e) => {
    if (!e.target.checked) {
      state.asm = [];
      paintAsm();
      $("asm").hidden = true;
      document.body.classList.remove("has-asm");
    } else {
      // 합필 모드에서는 상세 패널을 닫는다 (같은 자리)
      if (!$("detail").hidden) $("detailClose").click();
      renderAsm();
    }
  });
  $("asmClear").addEventListener("click", () => {
    state.asm = [];
    paintAsm();
    renderAsm();
  });
  $("asmClose").addEventListener("click", () => {
    $("asmMode").checked = false;
    state.asm = [];
    paintAsm();
    $("asm").hidden = true;
    document.body.classList.remove("has-asm");
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
    if (e.key === "Enter" && state.draw.on) { drawFinish(); return; }
    if (e.key !== "Escape") return;
    if (state.draw.on) { drawCancel(); return; }
    if (!$("about").hidden) { $("aboutClose").click(); return; }
    if ($("asmMode").checked && state.asm.length) { $("asmClear").click(); return; }
    if (!$("detail").hidden) $("detailClose").click();
  });
}

boot().catch((err) => {
  console.error(err);
  $("bootText").innerHTML =
    `데이터를 불러오지 못했습니다.<br><span style="color:var(--ink-3);font-size:12px">${err.message}</span>`;
  document.querySelector("#boot .bar").style.display = "none";
});
