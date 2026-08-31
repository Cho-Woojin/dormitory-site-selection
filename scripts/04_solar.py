"""T-204, T-303 — 건물 높이 정규화 + 일조환경 지표 (S₂).

  T-204  높이(A16) → 없으면 층수(A26)×층고 → 둘 다 없으면 바닥면적 구간 추정 (D-012)
  T-303  남측 섹터별 최대 앙각 → 개방도, 남측 접도 보너스

METHODOLOGY §3 구현. 필지 5.3만 × 건물 4만이므로
STRtree 공간색인 + numpy 벡터화로 처리한다. 행 루프 금지.

출력: data/interim/buildings.gpkg, parcels_s2.gpkg
"""
import time

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely import STRtree

from common import BUILDING_COLS, BUILDINGS_SHP, ENCODING, INTERIM, load_config


def normalize_heights(cfg):
    """T-204 — 건물 높이를 3단계 폴백으로 확정한다."""
    S = cfg["solar"]
    sgg = cfg["region"]["sgg_code"]

    b = gpd.read_file(BUILDINGS_SHP, encoding=ENCODING, where=f"A23 = '{sgg}'")
    b = b[list(BUILDING_COLS) + ["geometry"]].rename(columns=BUILDING_COLS)
    for c in ["height_m", "floors_up"]:
        b[c] = pd.to_numeric(b[c], errors="coerce")
    b["footprint_sqm"] = b.geometry.area
    n = len(b)
    print(f"  성북구 건물: {n:,}동   좌표계 {b.crs.to_string()}")

    # 이상치 — 음수 높이, 비현실적 고층
    bad = b["height_m"].lt(0) | b["height_m"].gt(200)
    if bad.any():
        print(f"  이상치 높이 {int(bad.sum())}건 → 결측 처리 "
              f"(min {b.loc[bad, 'height_m'].min():.1f}m)")
        b.loc[bad, "height_m"] = np.nan

    fh = S["default_floor_height_m"]
    src = np.full(n, "", dtype=object)
    h = np.full(n, np.nan)

    m1 = b["height_m"].gt(0).to_numpy()
    h[m1] = b.loc[m1, "height_m"]
    src[m1] = "실측"

    m2 = ~m1 & b["floors_up"].gt(0).to_numpy()
    h[m2] = b.loc[m2, "floors_up"] * fh
    src[m2] = "층수추정"

    m3 = ~m1 & ~m2
    U = S["unknown_building"]
    if U["method"] == "footprint_bin":
        # 바닥면적 구간 → 중위 층수 (D-012). np.searchsorted 로 벡터 처리.
        edges = [x["max"] for x in U["footprint_bins"][:-1]]
        floors = np.array([x["floors"] for x in U["footprint_bins"]])
        idx = np.searchsorted(edges, b["footprint_sqm"].to_numpy(), side="left")
        h[m3] = floors[idx][m3] * fh
        src[m3] = "면적추정"
    elif U["method"] == "exclude":
        src[m3] = "제외"
    else:
        raise SystemExit(f"unknown_building.method 값이 잘못됨: {U['method']}")

    b["height_m"] = h
    b["height_src"] = src

    print(f"\n  높이 출처별 (T-204 완료조건)")
    for label in ["실측", "층수추정", "면적추정", "제외"]:
        k = int((src == label).sum())
        if k:
            hh = b.loc[src == label, "height_m"]
            extra = f"  중위 {hh.median():.1f}m" if hh.notna().any() else ""
            print(f"    {label:<8} {k:>7,}  {k / n:>5.1%}{extra}")
    print(f"    {'이상치>200m':<8} {int(b['height_m'].gt(200).sum()):>7,}")

    b = b[b["height_m"].notna()].copy()
    print(f"  → 일조 계산에 사용할 건물: {len(b):,}동")
    return b


def solar_openness(g, b, cfg):
    """T-303 — 남측 섹터별 최대 앙각에서 개방도를 구한다.

    각 필지 대표점을 중심으로 반경 R 안의 건물을 STRtree 로 찾고,
    (방위각, 앙각) 을 numpy 로 한 번에 계산한 뒤 섹터별 최대 앙각을 집계한다.
    """
    S = cfg["solar"]
    R = S["search_radius_m"]
    theta_ref = S["winter_solstice_altitude"]
    step = S["sector_step_deg"]
    a0, a1 = S["sector_start_deg"], S["sector_end_deg"]
    n_sec = int((a1 - a0) / step)

    pts = g.geometry.representative_point()
    px, py = pts.x.to_numpy(), pts.y.to_numpy()

    # 건물 대표점과 높이 — 건물을 점으로 근사한다.
    # 폴리곤 최근접거리를 쓰면 정확하지만 5.3만×주변건물 조합에 너무 비싸다.
    bpt = b.geometry.representative_point()
    bx, by = bpt.x.to_numpy(), bpt.y.to_numpy()
    bh = b["height_m"].to_numpy()

    tree = STRtree(gpd.points_from_xy(bx, by))
    # 반경 R 원과 교차하는 건물 인덱스 — (parcel_i, building_j) 쌍으로 반환
    pi, bj = tree.query(pts.buffer(R).values, predicate="intersects")
    print(f"  이웃 쌍: {len(pi):,} (필지당 평균 {len(pi) / len(g):.1f}동)")

    dx = bx[bj] - px[pi]
    dy = by[bj] - py[pi]
    dist = np.hypot(dx, dy)
    ok = dist > 1.0            # 자기 필지 위 건물은 제외 (그림자 대상 아님)
    pi, bj, dx, dy, dist = pi[ok], bj[ok], dx[ok], dy[ok], dist[ok]

    # 방위각: 북=0°, 시계방향. 남=180°
    az = (np.degrees(np.arctan2(dx, dy)) + 360) % 360
    in_sector = (az >= a0) & (az < a1)
    pi, bj, dist, az = pi[in_sector], bj[in_sector], dist[in_sector], az[in_sector]

    elev = np.degrees(np.arctan2(bh[bj], dist))   # 앙각
    sec = ((az - a0) // step).astype(int)

    # 섹터별 최대 앙각 — np.maximum.at 으로 한 번에 집계
    max_elev = np.zeros((len(g), n_sec))
    np.maximum.at(max_elev, (pi, sec), elev)

    openness = np.clip((theta_ref - max_elev) / theta_ref, 0, 1)
    # 정남(180°)에 가까운 섹터에 큰 가중치
    centers = a0 + step * (np.arange(n_sec) + 0.5)
    w = np.cos(np.radians(centers - 180.0))
    return (openness * w).sum(axis=1) / w.sum()


def main():
    cfg = load_config()
    S = cfg["solar"]

    print("═" * 62)
    print("T-204  건물 높이 정규화")
    b = normalize_heights(cfg)
    b.to_file(INTERIM / "buildings.gpkg", driver="GPKG", layer="buildings")

    print("\n" + "═" * 62)
    print("T-303  일조환경 (S₂)")
    g = gpd.read_file(INTERIM / "parcels_s3.gpkg", layer="parcels")
    print(f"  필지 {len(g):,} × 건물 {len(b):,}")
    print(f"  섹터 {S['sector_start_deg']}~{S['sector_end_deg']}° / {S['sector_step_deg']}°,"
          f" 반경 {S['search_radius_m']}m, 기준앙각 {S['winter_solstice_altitude']}°")

    t0 = time.time()
    g["sun_raw"] = solar_openness(g, b, cfg)

    # 남측 접도 보너스 — 도로는 영구히 열려 있다 (METHODOLOGY §3.3).
    # A24 도로측면은 방위 정보가 없으므로 '접도 등급'을 폭의 대용으로 쓴다.
    width = {
        "광대로한면": 25, "광대소각": 25, "광대세각": 25,
        "중로한면": 12, "중로각지": 12,
        "소로한면": 8, "소로각지": 8,
        "세로한면(가)": 4, "세로각지(가)": 4,
    }
    w = g["road_side"].map(width).fillna(0.0)
    # 각지(角地)는 두 면이 도로 → 남측일 확률이 높다
    corner = g["road_side"].str.contains("각지|소각|세각", na=False)
    p_south = np.where(corner, 0.5, 0.25)
    bonus = (S["road_bonus"] * p_south
             * np.minimum(w / S["road_bonus_full_width_m"], 1.0))
    g["sun"] = np.clip(g["sun_raw"] * (1 + bonus), 0, 1)
    print(f"  소요 {time.time() - t0:.1f}초")

    c = g[g["is_candidate"]]
    q = c["sun"].quantile([0.05, 0.25, 0.5, 0.75, 0.95])
    print(f"\n  후보 {len(c):,} 필지 S₂ 분포")
    print(f"    5% {q[0.05]:.3f} | 25% {q[0.25]:.3f} | 중위 {q[0.5]:.3f}"
          f" | 75% {q[0.75]:.3f} | 95% {q[0.95]:.3f}")
    print(f"    접도보너스 적용 전 중위 {c['sun_raw'].median():.3f}")

    print("\n  접도 등급별 S₂ 중위 (열린 도로일수록 높아야 함)")
    for r, sub in c.groupby("road_side"):
        if len(sub) >= 30:
            print(f"    {r:<12} {len(sub):>5,}필지  {sub['sun'].median():.3f}")

    print("\n  지형별 S₂ 중위")
    for t, sub in c.groupby("terrain"):
        if len(sub) >= 30:
            print(f"    {t:<10} {len(sub):>5,}필지  {sub['sun'].median():.3f}")

    if c["sun"].std() < 0.01:
        raise SystemExit("❌ S₂ 분산이 거의 0 — 지표가 필지를 구분하지 못함")

    out = INTERIM / "parcels_s2.gpkg"
    g.to_file(out, driver="GPKG", layer="parcels")
    print(f"\n✅ 저장: {out}")


if __name__ == "__main__":
    main()
