/* 점수 엔진 - Python 파이프라인의 JS 구현.
 *
 * 대조 기준:
 *   scripts/02_metrics_s1.py   S1 사업성
 *   scripts/05_ranking.py      rank_lexicographic()
 *   scripts/07_verify_tiles.py 재계산 블록
 *
 * 이 파일이 Python과 어긋나면 웹은 조용히 틀린 답을 보여준다.
 * 수식을 임의로 바꾸지 말 것. 바꿔야 한다면 METHODOLOGY.md 를 먼저 고친다.
 */

export const GRADE_ORDER = { A: 0, B: 1, C: 2, D: 3, E: 4 };
export const GRADE_LABELS = ["A", "B", "C", "D", "E"];

/** 하드 필터 비트 (meta.json flag_bits 와 일치해야 한다) */
export const FLAG = {
  JIMOK: 1, ZONE: 2, LANDUSE: 4, ROAD: 8, ROOMS: 16, PRICE: 32,
  ROAD_UNKNOWN: 256, ZONE2: 512, SUBDIVIDED: 1024, INDUSTRIAL: 2048,
};
/** 정적 제외 비트. ROOMS 는 파라미터 의존이라 매번 다시 판정한다. */
const STATIC_EXCLUDE =
  FLAG.JIMOK | FLAG.ZONE | FLAG.LANDUSE | FLAG.ROAD | FLAG.PRICE;

export const FLAG_REASONS = [
  [FLAG.JIMOK, "지목이 '대'가 아님"],
  [FLAG.ZONE, "용도지역에서 공동주택 불가"],
  [FLAG.LANDUSE, "토지이용상황이 매입·건축 불가"],
  [FLAG.ROAD, "맹지 또는 자동차 통행 불가"],
  [FLAG.ROOMS, "최소 실 수 미달"],
  [FLAG.PRICE, "공시지가 결측"],
];

/**
 * scoring.json 을 타입드 배열로 펼친다. 27,857행을 매번 객체로 다루면
 * 슬라이더가 버벅인다.
 */
export function prepare(scoring, scale) {
  const n = scoring.ids.length;
  const col = (k) => scoring.cols.indexOf(k);
  const [ia, iff, ir, ip, id_, is, it, ix] =
    ["a", "f", "r", "p", "d", "s", "t", "x"].map(col);

  const out = {
    n,
    ids: scoring.ids,
    names: scoring.nm,
    zones: scoring.z,
    sgg: scoring.g,
    area: new Float64Array(n),
    far: new Float64Array(n),
    rf: new Float64Array(n),
    price: new Float64Array(n),
    demo: new Float64Array(n),
    sun: new Float64Array(n),
    dist: new Float64Array(n),
    flags: new Int32Array(n),
  };
  for (let i = 0; i < n; i++) {
    const r = scoring.rows[i];
    out.area[i] = r[ia] / scale.a;
    out.far[i] = r[iff];
    out.rf[i] = r[ir] / scale.r;
    out.price[i] = r[ip] / scale.p;
    out.demo[i] = r[id_] / scale.d;
    out.sun[i] = r[is] / scale.s;
    out.dist[i] = r[it] / scale.t;
    out.flags[i] = r[ix];
  }
  return out;
}

/** 필지 하나의 사업성. 상세 패널에서도 같은 함수를 쓴다. */
export function financials(area, far, rf, price, demo, P) {
  const gfa = (area * far) / 100 * rf;
  const rooms = Math.floor((gfa * P.net_area_ratio) / P.room_area_sqm);
  const land = price * area * P.land_price_multiplier;
  const build = gfa * P.unit_construction_cost * (1 + P.soft_cost_ratio);
  const demoCost = demo * P.demolition_cost_per_sqm;
  const total = land + build + demoCost;
  const deposit = rooms * P.deposit_per_room;
  const equity = total - deposit;
  const noi =
    rooms * P.monthly_rent_per_room * 12 *
    (1 - P.vacancy_rate) * (1 - P.opex_ratio);
  const denom =
    P.denominator === "total_cost" ? total :
    P.denominator === "land_cost" ? land : equity;
  return {
    gfa, rooms, land, build, demoCost, total, deposit, equity, noi,
    s1: denom > 0 ? noi / denom : NaN,
  };
}

function gradeOf(dist, g) {
  if (dist <= g.A) return 0;
  if (dist <= g.B) return 1;
  if (dist <= g.C) return 2;
  if (dist <= g.D) return 3;
  return 4;
}

/**
 * 백분위 순위를 0~100 으로. pandas 의 rank(pct=True) 와 같이
 * **동점은 평균 순위**를 갖는다. 이걸 안 맞추면 밴드 경계에서 Python 과 갈린다.
 */
function pctRank(values, idx) {
  const m = idx.length;
  const order = Array.from(idx).sort((p, q) => values[p] - values[q]);
  const out = new Float64Array(values.length);
  let i = 0;
  while (i < m) {
    let j = i;
    while (j + 1 < m && values[order[j + 1]] === values[order[i]]) j++;
    const avg = (i + j + 2) / 2;            // 1-based 평균 순위
    for (let k = i; k <= j; k++) out[order[k]] = (avg / m) * 100;
    i = j + 1;
  }
  return out;
}

/**
 * 오차범위 계층 정렬 (METHODOLOGY 0장).
 *   정렬키 = (band1 ↑, band2 ↑, grade3 ↑, S1 ↓)
 * 반환: { order, s1, rooms, grade, isCand, rankOf }
 */
export function computeRanking(D, P, opts = {}) {
  const { n } = D;
  const s1 = new Float64Array(n);
  const rooms = new Int32Array(n);
  const grade = new Int8Array(n);
  const isCand = new Uint8Array(n);
  const cand = [];

  const excludeSubdivided = !!opts.excludeSubdivided;
  // 자치구 필터. 단일 임대료로 자치구를 비교하면 왜곡되므로 한 구씩 보게 한다.
  const onlySgg = opts.onlySgg ? Number(opts.onlySgg) : 0;

  for (let i = 0; i < n; i++) {
    const f = financials(
      D.area[i], D.far[i], D.rf[i], D.price[i], D.demo[i], P
    );
    s1[i] = f.s1;
    rooms[i] = f.rooms;
    grade[i] = gradeOf(D.dist[i], P.grades);

    let ok =
      (D.flags[i] & STATIC_EXCLUDE) === 0 &&
      f.rooms >= P.min_rooms &&
      Number.isFinite(f.s1);
    if (ok && excludeSubdivided && D.flags[i] & FLAG.SUBDIVIDED) ok = false;
    if (ok && onlySgg && D.sgg[i] !== onlySgg) ok = false;
    isCand[i] = ok ? 1 : 0;
    if (ok) cand.push(i);
  }

  const p1 = pctRank(s1, cand);
  const p2 = pctRank(D.sun, cand);
  const t1 = P.tol_profitability_pct;
  const t2 = P.tol_solar_pct;

  // tol=0 이면 밴딩하지 않는다. 그 지표 단독 정렬이 된다.
  const b1 = (i) => (t1 === 0 ? -p1[i] : Math.floor((100 - p1[i]) / t1));
  const b2 = (i) => (t2 === 0 ? -p2[i] : Math.floor((100 - p2[i]) / t2));

  const order = cand.slice().sort((x, y) =>
    b1(x) - b1(y) ||
    b2(x) - b2(y) ||
    grade[x] - grade[y] ||
    s1[y] - s1[x]
  );

  const rankOf = new Int32Array(n).fill(0);
  for (let r = 0; r < order.length; r++) rankOf[order[r]] = r + 1;

  return { order, s1, rooms, grade, isCand, rankOf, p1, p2 };
}

export function exclusionReasons(flags, rooms, minRooms) {
  const out = [];
  for (const [bit, label] of FLAG_REASONS) {
    if (bit === FLAG.ROOMS) {
      if (rooms < minRooms) out.push(`최소 실 수 미달 (${rooms}실 < ${minRooms}실)`);
    } else if (flags & bit) out.push(label);
  }
  return out;
}
