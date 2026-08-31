"""T-201 ~ T-203, T-206 — 필지 마스터 구축.

  T-201  토지특성정보 로드 + PNU·좌표계 검증
  T-202  컬럼 A0~A26 → 의미 있는 이름으로 매핑
  T-203  용도지역 → 용적률·건폐율·기숙사가능 매핑
  T-206  AL_D151 개별공시지가로 공시지가 갱신 (기준일 2주 최신)

출력: data/interim/parcels.gpkg
"""
import zipfile

import geopandas as gpd
import numpy as np
import pandas as pd

from common import (
    ENCODING, INTERIM, LANDPRICE_ZIP, PARCELS_SHP, PARCEL_COLS,
    applied_far, load_config,
)


def main():
    cfg = load_config()
    sgg = cfg["region"]["sgg_code"]

    # ── T-201 로드 + 검증 ────────────────────────────────────────────────
    print("═" * 62)
    print("T-201  토지특성정보 로드")
    g = gpd.read_file(PARCELS_SHP, encoding=ENCODING)
    print(f"  필지 수      : {len(g):,}")
    print(f"  좌표계       : {g.crs.to_string()}")
    assert g.crs.to_epsg() == 5186, f"좌표계가 EPSG:5186이 아님: {g.crs}"

    # ── T-202 컬럼 매핑 ─────────────────────────────────────────────────
    print("\nT-202  컬럼 매핑")
    missing = set(PARCEL_COLS) - set(g.columns)
    assert not missing, f"원본에 없는 컬럼: {missing}"
    g = g[list(PARCEL_COLS) + ["geometry"]].rename(columns=PARCEL_COLS)

    g["area_sqm"] = pd.to_numeric(g["area_sqm"], errors="coerce")
    g["price_krw_sqm"] = pd.to_numeric(g["price_krw_sqm"], errors="coerce")

    bad_len = (g["pnu"].str.len() != 19).sum()
    dup = g["pnu"].duplicated().sum()
    wrong_sgg = (~g["pnu"].str.startswith(sgg)).sum()
    print(f"  PNU 19자리 아님 : {bad_len:,}")
    print(f"  PNU 중복        : {dup:,}")
    print(f"  시군구코드 불일치: {wrong_sgg:,}")
    assert bad_len == 0 and dup == 0 and wrong_sgg == 0, "PNU 무결성 실패"
    print(f"  면적 결측       : {g['area_sqm'].isna().sum():,}")
    print(f"  공시지가 결측/0 : {(g['price_krw_sqm'].isna() | g['price_krw_sqm'].eq(0)).sum():,}")
    print(f"  공시지가 기준일 : {g['price_ref_date'].mode()[0]}")

    # ── T-203 용도지역 → 용적률·건폐율 ──────────────────────────────────
    print("\nT-203  용도지역 매핑")
    far_map = applied_far(cfg)
    zones = cfg["zoning"]["zones"]
    g["far_pct"] = g["zone1"].map(far_map)
    g["bcr_pct"] = g["zone1"].map(lambda z: zones.get(z, {}).get("bcr"))
    g["housing_ok"] = g["zone1"].map(
        lambda z: zones.get(z, {}).get("housing_ok", False)
    ).astype(bool)

    unmapped = g.loc[g["far_pct"].isna(), "zone1"].value_counts()
    if len(unmapped):
        print("  ⚠️ params.yaml에 없는 용도지역:")
        print(unmapped.to_string().replace("\n", "\n    "))
    else:
        print("  모든 용도지역이 params.yaml에 매핑됨 ✅")

    # 용도지역명2가 있으면 두 지역에 걸친 필지. zone1을 채택하되 플래그로 남긴다.
    g["straddles_zone"] = (
        g["zone2"].notna() & ~g["zone2"].isin(["지정되지않음", ""])
    )
    print(f"  용도지역 2곳에 걸친 필지: {g['straddles_zone'].sum():,} (zone1 채택)")

    dist = g["zone1"].value_counts()
    print("\n  용도지역 분포:")
    for z, n in dist.head(9).items():
        print(f"    {z:<14} {n:>6,}  {n / len(g):>5.1%}")

    # ── T-206 공시지가 갱신 ─────────────────────────────────────────────
    print("\nT-206  AL_D151 개별공시지가 갱신")
    with zipfile.ZipFile(LANDPRICE_ZIP) as z:
        name = z.namelist()[0]
        with z.open(name) as f:
            lp = pd.read_csv(
                f, encoding=ENCODING, dtype={"고유번호": str},
                usecols=["고유번호", "공시지가", "공시일자", "데이터기준일자"],
            )
    lp = lp[lp["고유번호"].str.startswith(sgg)]
    lp = lp.drop_duplicates("고유번호").set_index("고유번호")
    print(f"  성북구 레코드   : {len(lp):,}   공시일자: {lp['공시일자'].mode()[0]}")

    joined = g["pnu"].map(lp["공시지가"])
    rate = joined.notna().mean()
    print(f"  조인율          : {rate:.1%}  ({joined.notna().sum():,}/{len(g):,})")
    if rate < 0.90:
        raise SystemExit(f"조인율 {rate:.1%} < 90% — 원인 규명 전까지 진행 금지")

    both = g["price_krw_sqm"].notna() & joined.notna() & g["price_krw_sqm"].gt(0)
    diff = (joined[both] - g.loc[both, "price_krw_sqm"]).abs()
    print(f"  A25와 값 차이   : 동일 {(diff == 0).sum():,} / 상이 {(diff > 0).sum():,}")
    if (diff > 0).any():
        print(f"    상이분 중위 차이: {diff[diff > 0].median():,.0f} 원/㎡")

    # 갱신본을 채택하되 결측이면 A25 유지. 어느 쪽을 썼는지 기록한다.
    g["price_source"] = np.where(joined.notna(), "AL_D151_20260526", "AL_D194_A25")
    g["price_krw_sqm"] = joined.fillna(g["price_krw_sqm"])
    print(f"  최종 공시지가 결측/0: {(g['price_krw_sqm'].isna() | g['price_krw_sqm'].eq(0)).sum():,}")

    # ── 저장 ────────────────────────────────────────────────────────────
    INTERIM.mkdir(parents=True, exist_ok=True)
    out = INTERIM / "parcels.gpkg"
    g.to_file(out, driver="GPKG", layer="parcels")
    print(f"\n✅ 저장: {out}  ({len(g):,}행 × {len(g.columns)}컬럼)")


if __name__ == "__main__":
    main()
