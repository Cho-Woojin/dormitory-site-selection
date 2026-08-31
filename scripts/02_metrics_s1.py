"""T-301 ~ T-302 — 하드 필터 + S₁ 사업성.

  T-301  하드 필터 F1·F3·F4·F5·F6 → flags 비트마스크
  T-302  S₁ 사업성 (순투자금 / 총사업비 / 토지비 3종)

METHODOLOGY §1, §2 를 구현한다. 수식을 임의로 바꾸지 말 것.
출력: data/interim/parcels_s1.gpkg
"""
import geopandas as gpd
import numpy as np
import pandas as pd

from common import (
    F_JIMOK, F_LANDUSE, F_PRICE, F_ROAD, F_ROOMS, F_ZONE,
    FILTER_LABELS, INTERIM, W_ROAD_UNKNOWN, W_ZONE2, load_config,
)


def realization_factor(g, cfg):
    """실현계수 = base × 형상계수 × 지형계수 (D-006).

    형상·지형은 토지특성정보 실측값이고 base만 가정치다.
    """
    r = cfg["profitability"]["realization"]
    shape = g["land_shape"].map(r["shape_factor"])
    terrain = g["terrain"].map(r["slope_factor"])
    unmapped = pd.concat([
        g.loc[shape.isna(), "land_shape"], g.loc[terrain.isna(), "terrain"],
    ]).value_counts()
    if len(unmapped):
        print("  ⚠️ params.yaml에 없는 형상/지형 값 (기본값 대체):")
        print(unmapped.to_string().replace("\n", "\n    "))
    # 매핑 실패는 '지정되지않음' 계수로 대체 — 누락을 조용히 1.0으로 두지 않는다.
    return r["base"] * shape.fillna(r["shape_factor"]["지정되지않음"]) \
                     * terrain.fillna(r["slope_factor"]["지정되지않음"])


def main():
    cfg = load_config()
    P, F = cfg["profitability"], cfg["filters"]

    g = gpd.read_file(INTERIM / "parcels.gpkg", layer="parcels")
    print("═" * 62)
    print(f"입력: {len(g):,} 필지\n")

    # ── 파생값 ──────────────────────────────────────────────────────────
    print("실현계수 (D-006)")
    g["realization"] = realization_factor(g, cfg)
    q = g["realization"].quantile([0, 0.5, 1])
    print(f"  중위 {q[0.5]:.2f}   범위 {q[0.0]:.2f} ~ {q[1.0]:.2f}")

    g["gfa_sqm"] = g["area_sqm"] * g["far_pct"].fillna(0) / 100 * g["realization"]
    g["rooms"] = np.floor(g["gfa_sqm"] * P["net_area_ratio"] / P["room_area_sqm"])

    # ── T-301 하드 필터 ─────────────────────────────────────────────────
    print("\n" + "═" * 62)
    print("T-301  하드 필터")
    flags = np.zeros(len(g), dtype=np.int32)
    flags |= np.where(~g["jimok"].isin(F["allowed_jimok"]), F_JIMOK, 0)
    flags |= np.where(~g["housing_ok"], F_ZONE, 0)
    flags |= np.where(g["landuse"].isin(F["excluded_landuse"]), F_LANDUSE, 0)
    flags |= np.where(g["road_side"].isin(F["excluded_road_access"]), F_ROAD, 0)
    flags |= np.where(g["price_krw_sqm"].isna() | g["price_krw_sqm"].le(0), F_PRICE, 0)
    flags |= np.where(g["rooms"] < F["min_rooms"], F_ROOMS, 0)
    # 경고 비트 — 제외하지 않고 표시만 한다
    flags |= np.where(g["road_side"].eq("지정되지않음"), W_ROAD_UNKNOWN, 0)
    flags |= np.where(g["straddles_zone"], W_ZONE2, 0)
    g["flags"] = flags

    excl = F_JIMOK | F_ZONE | F_LANDUSE | F_ROAD | F_PRICE | F_ROOMS
    g["is_candidate"] = (g["flags"] & excl) == 0

    print("\n  필터별 단독 제외 건수 (중복 포함)")
    for bit, label in FILTER_LABELS:
        n = int((flags & bit).astype(bool).sum())
        print(f"    {label:<16} {n:>7,}  {n / len(g):>6.1%}")

    print("\n  누적 퍼널")
    keep = pd.Series(True, index=g.index)
    print(f"    {'전체':<16} {len(g):>7,}")
    for bit, label in FILTER_LABELS:
        before = int(keep.sum())
        keep &= (flags & bit) == 0
        print(f"    {label:<16} {int(keep.sum()):>7,}  (−{before - int(keep.sum()):,})")

    n_cand = int(g["is_candidate"].sum())
    print(f"\n  ★ 후보 {n_cand:,} 필지 ({n_cand / len(g):.1%})")
    road_unknown = (g["flags"] & W_ROAD_UNKNOWN).astype(bool)
    zone2 = (g["flags"] & W_ZONE2).astype(bool)
    print(f"    경고: 도로측면 미지정 {int(road_unknown.sum()):,}"
          f" (후보 중 {int((road_unknown & g['is_candidate']).sum()):,}) — Q-07")
    print(f"    경고: 용도지역 걸침 {int(zone2.sum()):,}"
          f" (후보 중 {int((zone2 & g['is_candidate']).sum()):,})")

    # ── T-302 S₁ 사업성 ─────────────────────────────────────────────────
    print("\n" + "═" * 62)
    print("T-302  S₁ 사업성")
    land = g["price_krw_sqm"] * g["area_sqm"] * P["land_price_multiplier"]
    build = g["gfa_sqm"] * P["unit_construction_cost"] * (1 + P["soft_cost_ratio"])
    g["cost_land"] = land
    g["cost_total"] = land + build
    g["deposit"] = g["rooms"] * P["deposit_per_room"]
    g["net_equity"] = g["cost_total"] - g["deposit"]

    revenue = g["rooms"] * P["monthly_rent_per_room"] * 12 * (1 - P["vacancy_rate"])
    g["noi"] = revenue * (1 - P["opex_ratio"])

    for col, denom in [
        ("s1_net_equity", g["net_equity"]),
        ("s1_total_cost", g["cost_total"]),
        ("s1_land_cost", g["cost_land"]),
    ]:
        g[col] = np.where(denom > 0, g["noi"] / denom.where(denom > 0), np.nan)

    c = g[g["is_candidate"]]
    print(f"\n  후보 {len(c):,} 필지 기준")
    print(f"  실현계수 중위   : {c['realization'].median():.2f}"
          f"  (범위 {c['realization'].min():.2f} ~ {c['realization'].max():.2f})")
    print(f"  토지비 비중 중위: {(c['cost_land'] / c['cost_total']).median():.0%}")
    print(f"  보증금 비중 중위: {(c['deposit'] / c['cost_total']).median():.0%}")
    print(f"\n  {'분모':<22}{'중위':>8}{'5%':>9}{'95%':>9}")
    for col, label in [
        ("s1_net_equity", "순투자금 (기본) ★"),
        ("s1_total_cost", "총사업비"),
        ("s1_land_cost", "토지비"),
    ]:
        qq = c[col].quantile([0.05, 0.5, 0.95])
        print(f"  {label:<20}{qq[0.5]:>8.1%}{qq[0.05]:>9.1%}{qq[0.95]:>9.1%}")

    print(f"\n  후보 면적   중위 {c['area_sqm'].median():,.0f}㎡")
    print(f"  후보 실 수  중위 {c['rooms'].median():,.0f}실   (최대 {c['rooms'].max():,.0f})")
    print(f"  후보 공시지가 중위 {c['price_krw_sqm'].median():,.0f} 원/㎡")
    print("\n  후보 용도지역 분포:")
    for z, n in c["zone1"].value_counts().items():
        print(f"    {z:<14} {n:>5,}")

    # 상식 점검 — 이상하면 넘어가지 말고 멈춘다 (CLAUDE.md)
    med = c["s1_net_equity"].median()
    if not 0.01 < med < 0.15:
        raise SystemExit(f"❌ 중위 수익률 {med:.1%} 이 상식 범위(1~15%)를 벗어남. 파라미터 재점검 필요")

    out = INTERIM / "parcels_s1.gpkg"
    g.to_file(out, driver="GPKG", layer="parcels")
    print(f"\n✅ 저장: {out}  ({len(g):,}행)")


if __name__ == "__main__":
    main()
