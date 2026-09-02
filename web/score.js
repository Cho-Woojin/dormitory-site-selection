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
/* 수치 표는 열 우선 바이너리다. JSON 이면 55.9MB 를 파싱하느라 메인 스레드가
   막혀 지도 렌더링과 다툰다(라이브 실측 44~78초). 여기서는 버퍼를 잘라
   타입배열로 보는 것뿐이라 사실상 공짜다. */
function decodeBin(buf, schema, n) {
  const TYPES = { u1: Uint8Array, i2: Int16Array, i4: Int32Array, f8: BigInt64Array };
  const out = {};
  let off = 0;
  for (const col of schema) {
    const T = TYPES[col.t];
    const bytes = n * T.BYTES_PER_ELEMENT;
    // slice() 로 복사한다. 열 경계가 정렬돼 있지 않으면 뷰를 못 만든다.
    const raw = new T(buf.slice(off, off + bytes));
    off += bytes;
    const a = new Float64Array(n);
    if (col.d) {                       // 델타 → 누적합
      let acc = 0;
      for (let i = 0; i < n; i++) { acc += Number(raw[i]); a[i] = acc; }
    } else {
      for (let i = 0; i < n; i++) a[i] = Number(raw[i]);
    }
    out[col.c] = a;
  }
  return out;
}

export function prepare(scoring, scale, buf) {
  const n = scoring.ids.length;
  const B = decodeBin(buf, scoring.bin.schema, n);
  if (scoring.bin.n !== n) throw new Error(`scoring.bin 행 수 불일치 ${scoring.bin.n} vs ${n}`);

  /* 필지명은 싣지 않고 PNU 에서 복원한다 (89.9만 건 전수 대조 불일치 0).
     그대로 실으면 24MB, 법정동 이름표는 467개 18KB 다.
       PNU[0:5]=자치구  [0:10]=법정동  [11:15]=본번  [15:19]=부번
     495k 개를 미리 만들면 메모리·시간이 아깝다. 목록은 60행만 그리므로
     낱개 접근은 nameAt(), 전체 배열은 처음 쓸 때 만든다. */
  const bjd = scoring.bjd_names || {};
  const nameAt = (i) => {
    const p = scoring.ids[i];
    const bon = +p.slice(11, 15), bu = +p.slice(15, 19);
    return `${bjd[p.slice(0, 10)] || ""} ${bu ? `${bon}-${bu}` : bon}`;
  };
  const sgg = new Int32Array(n);
  for (let i = 0; i < n; i++) sgg[i] = +scoring.ids[i].slice(0, 5);

  const out = {
    n,
    ids: scoring.ids,
    nameAt,
    zones: scoring.z,
    sgg,
    adj: scoring.adj || [],     // 합필 모드에서 adjacency.json 을 받아 채운다
    tf: new Float64Array(n),
    ri: new Float64Array(n),
    cx: new Float64Array(n),
    cy: new Float64Array(n),
    lon: new Float64Array(n),
    lat: new Float64Array(n),
    priceDate: new Int8Array(n),                 // price_dates 인덱스
    priceDates: scoring.price_dates || [],
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
    out.area[i] = B.a[i] / scale.a;
    out.far[i] = B.f[i];
    out.rf[i] = B.r[i] / scale.r;
    out.price[i] = B.p[i] / scale.p;
    out.demo[i] = B.d[i] / scale.d;
    out.sun[i] = B.s[i] / scale.s;
    out.dist[i] = B.t[i] / scale.t;
    out.flags[i] = B.x[i];
    out.tf[i] = B.tf[i] / scale.tf;
    out.ri[i] = B.ri[i] / scale.ri;      // 임대료 지역지수 (D-024)
    out.cx[i] = B.cx[i];                 // 중심점 (EPSG:5186 미터)
    out.cy[i] = B.cy[i];
    out.lon[i] = B.lon[i] / 1e6;         // 같은 점의 WGS84 (지도 마커용)
    out.lat[i] = B.lat[i] / 1e6;
    out.priceDate[i] = B.pd[i];          // 공시일자 (필지마다 다를 수 있다)
  }
  // 전체 이름 배열은 쓰는 쪽이 있을 때만 만든다 (테스트·캡처가 findIndex 를 쓴다).
  Object.defineProperty(out, "names", {
    configurable: true,
    get() {
      const a = new Array(n);
      for (let i = 0; i < n; i++) a[i] = nameAt(i);
      Object.defineProperty(out, "names", { value: a, configurable: true });
      return a;
    },
  });
  return out;
}

/** 필지 하나의 사업성. 상세 패널에서도 같은 함수를 쓴다. */
export function financials(area, far, rf, price, demo, P, rentIndex = 1) {
  const gfa = (area * far) / 100 * rf;
  const rooms = Math.floor((gfa * P.net_area_ratio) / P.room_area_sqm);
  const land = price * area * P.land_price_multiplier;
  const build = gfa * P.unit_construction_cost * (1 + P.soft_cost_ratio);
  const demoCost = demo * P.demolition_cost_per_sqm;
  const total = land + build + demoCost;
  const deposit = rooms * P.deposit_per_room;
  const equity = total - deposit;
  // 임대료는 기준 자치구 값 × 지역지수 (D-024)
  const rent = P.monthly_rent_per_room * rentIndex;
  const noi = rooms * rent * 12 * (1 - P.vacancy_rate) * (1 - P.opex_ratio);
  const denom =
    P.denominator === "total_cost" ? total :
    P.denominator === "land_cost" ? land : equity;
  return {
    gfa, rooms, land, build, demoCost, total, deposit, equity, noi, rent,
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
  // 폴리곤 범위. Set<index> 로 미리 계산해 넘긴다 (기하 계산은 여기서 하지 않는다).
  const inArea = opts.inArea || null;

  for (let i = 0; i < n; i++) {
    const f = financials(
      D.area[i], D.far[i], D.rf[i], D.price[i], D.demo[i], P, D.ri[i]
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
    if (ok && inArea && !inArea.has(i)) ok = false;
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

/* ───────────────────────────────────────────────────────────────────
 * 합필 (인접 필지 통합)
 *
 * scripts/08_assembly.py 와 같은 식을 쓴다. 어긋나면 웹이 틀린 규모를 보여준다.
 *   면적       = Σ 개별 면적
 *   용적률     = 면적가중 평균
 *   형상계수   = clip(0.70 + 0.32 × 면적/MRR면적, 0.70, 1.00)
 *   지형계수   = 최대 필지의 것
 *   실현계수   = base × 형상계수 × 지형계수
 * ─────────────────────────────────────────────────────────────────── */

/** 볼록껍질 (Andrew monotone chain). 입력 [[x,y],…] */
export function convexHull(pts) {
  if (pts.length < 3) return pts.slice();
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const build = (src) => {
    const h = [];
    for (const q of src) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop();
      h.push(q);
    }
    h.pop();
    return h;
  };
  return build(p).concat(build(p.reverse()));
}

/**
 * 최소회전외접사각형의 면적 (회전 캘리퍼스).
 * shapely 의 minimum_rotated_rectangle 과 같은 값을 준다.
 * MRR(폴리곤) = MRR(볼록껍질) 이므로 껍질만 있으면 된다.
 */
export function minRotatedRectArea(pts) {
  const h = convexHull(pts);
  if (h.length < 3) return 0;
  let best = Infinity;
  for (let i = 0; i < h.length; i++) {
    const j = (i + 1) % h.length;
    const dx = h[j][0] - h[i][0];
    const dy = h[j][1] - h[i][1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const ux = dx / len, uy = dy / len;
    let m1 = Infinity, M1 = -Infinity, m2 = Infinity, M2 = -Infinity;
    for (const q of h) {
      const a = q[0] * ux + q[1] * uy;      // 변 방향 투영
      const b = -q[0] * uy + q[1] * ux;     // 수직 방향 투영
      if (a < m1) m1 = a; if (a > M1) M1 = a;
      if (b < m2) m2 = b; if (b > M2) M2 = b;
    }
    const area = (M1 - m1) * (M2 - m2);
    if (area < best) best = area;
  }
  return best === Infinity ? 0 : best;
}

/**
 * 합필 지표.
 * @param items  [{area, far, tf, price, demo, sun, dist, flags, zoneCode}]
 * @param hullPts  합필 폴리곤 꼭짓점 (미터 좌표). 없으면 형상계수를 면적가중으로 근사.
 */
export function assemble(items, hullPts, P, A) {
  const area = items.reduce((s, x) => s + x.area, 0);
  if (!area) return null;
  const far = items.reduce((s, x) => s + x.far * x.area, 0) / area;
  // 지형계수는 최대 필지의 것 (08_assembly.py 와 동일)
  const biggest = items.reduce((m, x) => (x.area > m.area ? x : m), items[0]);

  let shapeF, exact = false;
  if (hullPts && hullPts.length >= 3) {
    const mrr = minRotatedRectArea(hullPts);
    if (mrr > 0) {
      shapeF = Math.min(1.0, Math.max(0.70,
        A.shape_factor_base + A.shape_factor_span * Math.min(1, area / mrr)));
      exact = true;
    }
  }
  if (!exact) {
    // 도형을 못 얻은 경우: 개별 실현계수의 면적가중 평균에서 형상계수를 역산
    const rfAvg = items.reduce((s, x) => s + x.rf * x.area, 0) / area;
    shapeF = rfAvg / (A.realization_base * biggest.tf);
  }
  const rf = A.realization_base * shapeF * biggest.tf;

  const gfa = (area * far) / 100 * rf;
  const rooms = Math.floor((gfa * P.net_area_ratio) / P.room_area_sqm);
  const land = items.reduce((s, x) => s + x.price * x.area, 0) * P.land_price_multiplier;
  const build = gfa * P.unit_construction_cost * (1 + P.soft_cost_ratio);
  const demoCost = items.reduce((s, x) => s + x.demo, 0) * P.demolition_cost_per_sqm;
  const total = land + build + demoCost;
  const deposit = rooms * P.deposit_per_room;
  const equity = total - deposit;
  const ri = items.reduce((s, x) => s + (x.ri ?? 1) * x.area, 0) / area;
  const noi = rooms * P.monthly_rent_per_room * ri * 12
    * (1 - P.vacancy_rate) * (1 - P.opex_ratio);
  const denom =
    P.denominator === "total_cost" ? total :
    P.denominator === "land_cost" ? land : equity;

  return {
    n: items.length, area, far, rf, shapeF, exact, ri,
    gfa, rooms, land, build, demoCost, total, deposit,
    s1: denom > 0 ? noi / denom : NaN,
    sun: items.reduce((s, x) => s + x.sun, 0) / items.length,
    dist: Math.min(...items.map((x) => x.dist)),
  };
}

/** 점이 폴리곤 안에 있는가 (ray casting). ring 은 [[x,y],…] */
export function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) &&
        pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 두 선분이 교차하는가. 필지가 폴리곤 경계를 '지나가는' 경우를 잡는다. */
function segIntersect(a, b, c, d) {
  const o = (p, q, r) =>
    Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return o1 !== o2 && o3 !== o4;
}

/**
 * 필지 링이 폴리곤과 겹치는가 (교차 = intersects).
 * "폴리곤 위를 지나가는 필지도 포함" 이라는 요구를 만족시키려면
 * 포함(within)이 아니라 교차로 판정해야 한다.
 *   1) 필지 꼭짓점 하나라도 폴리곤 안 → 포함
 *   2) 폴리곤 꼭짓점 하나라도 필지 안 → 폴리곤이 필지 안에 쏙 들어간 경우
 *   3) 변끼리 교차       → 경계를 가로지르는 경우
 */
export function ringIntersectsPolygon(ring, poly) {
  for (const p of ring) if (pointInRing(p, poly)) return true;
  for (const p of poly) if (pointInRing(p, ring)) return true;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    for (let j = 0; j < poly.length; j++) {
      if (segIntersect(a, b, poly[j], poly[(j + 1) % poly.length])) return true;
    }
  }
  return false;
}

/** 선택 집합이 연접으로 하나로 이어지는가. 끊기면 몇 덩어리인지 돌려준다. */
export function connectivity(indices, adj) {
  const set = new Set(indices);
  const seen = new Set();
  const groups = [];
  for (const start of indices) {
    if (seen.has(start)) continue;
    const stack = [start], g = [];
    seen.add(start);
    while (stack.length) {
      const i = stack.pop();
      g.push(i);
      for (const j of adj[i] || []) {
        if (set.has(j) && !seen.has(j)) { seen.add(j); stack.push(j); }
      }
    }
    groups.push(g);
  }
  return groups;
}


/* ───────────────────────────────────────────────────────────────────
 * 거점 네트워크
 *
 * 단일 필지 최적화 결과를 그대로 거점 선정에 쓰면 안 된다.
 * 상위 후보는 한 블록에 몰린다 (성동구 상위 30 중 21개가 100m 이내,
 * 용답동 230번지 한 블록에만 9개). 카니발라이제이션·커버리지 0·리스크 집중.
 * 최소 이격거리를 걸고 순위 상위부터 탐욕적으로 고른다.
 * ─────────────────────────────────────────────────────────────────── */

/** 사이트(거점) 하나의 대표 좌표. 합필이면 면적가중 중심. */
export function siteCenter(indices, D) {
  let sx = 0, sy = 0, sa = 0;
  for (const i of indices) {
    sx += D.cx[i] * D.area[i];
    sy += D.cy[i] * D.area[i];
    sa += D.area[i];
  }
  return sa ? [sx / sa, sy / sa] : [0, 0];
}

/**
 * 최소 이격거리를 지키며 순위 상위부터 N개 거점 선정.
 * @param order   계층 정렬 결과 (인덱스 배열)
 * @param fixed   먼저 확정할 사이트들의 중심좌표 [[x,y],…] (저장한 합필 등)
 */
export function pickHubs(order, D, { n = 5, minDist = 1000, fixed = [] } = {}) {
  const picked = [];
  const centers = fixed.slice();
  for (const i of order) {
    if (picked.length + fixed.length >= n) break;
    const x = D.cx[i], y = D.cy[i];
    if (centers.some((c) => Math.hypot(x - c[0], y - c[1]) < minDist)) continue;
    picked.push(i);
    centers.push([x, y]);
  }
  return picked;
}

/** 사이트 집합의 최근접 거점 간 거리 (분산 정도를 보는 값). */
export function minSpacing(centers) {
  let m = Infinity;
  for (let i = 0; i < centers.length; i++) {
    for (let j = i + 1; j < centers.length; j++) {
      m = Math.min(m, Math.hypot(centers[i][0] - centers[j][0],
                                 centers[i][1] - centers[j][1]));
    }
  }
  return centers.length < 2 ? null : m;
}

/**
 * 합필 묶음이 단일 필지들 사이에서 몇 위에 해당하는가.
 * 계층 정렬과 같은 키로 비교한다 (band1, band2, grade, S1).
 * 합필 결과를 단일 필지와 나란히 놓고 보려면 이 값이 필요하다.
 */
export function virtualRank(s1, sun, grade, res, D, P) {
  const cand = res.order;
  if (!cand.length || !Number.isFinite(s1)) return null;
  // 백분위: 후보 중 이 값보다 작은 것의 비율 (pandas rank(pct) 와 같은 정의)
  let lt1 = 0, eq1 = 0, lt2 = 0, eq2 = 0;
  for (const i of cand) {
    if (res.s1[i] < s1) lt1++; else if (res.s1[i] === s1) eq1++;
    if (D.sun[i] < sun) lt2++; else if (D.sun[i] === sun) eq2++;
  }
  const m = cand.length + 1;                       // 자신을 포함한 모수
  const p1 = ((lt1 + (eq1 + 1 + 1) / 2) / m) * 100;
  const p2 = ((lt2 + (eq2 + 1 + 1) / 2) / m) * 100;
  const t1 = P.tol_profitability_pct, t2 = P.tol_solar_pct;
  const b1 = t1 === 0 ? -p1 : Math.floor((100 - p1) / t1);
  const b2 = t2 === 0 ? -p2 : Math.floor((100 - p2) / t2);

  let before = 0;
  for (const i of cand) {
    const cb1 = t1 === 0 ? -res.p1[i] : Math.floor((100 - res.p1[i]) / t1);
    if (cb1 < b1) { before++; continue; }
    if (cb1 > b1) continue;
    const cb2 = t2 === 0 ? -res.p2[i] : Math.floor((100 - res.p2[i]) / t2);
    if (cb2 < b2) { before++; continue; }
    if (cb2 > b2) continue;
    if (res.grade[i] < grade) { before++; continue; }
    if (res.grade[i] > grade) continue;
    if (res.s1[i] > s1) before++;
  }
  return before + 1;
}
