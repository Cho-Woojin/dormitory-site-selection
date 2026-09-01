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
    ENCODING, INTERIM, LANDPRICE_ZIP, PARCEL_COLS,
    applied_far, load_config, parcel_shp,
)


def main():
    cfg = load_config()
    districts = cfg["region"]["districts"]
    codes = [d["code"] for d in districts]

    # ── T-201 로드 + 검증 ────────────────────────────────────────────────
    print("═" * 62)
    print("T-201  토지특성정보 로드")
    parts = []
    for d in districts:
        one = gpd.read_file(parcel_shp(d), encoding=ENCODING)
        assert one.crs.to_epsg() == 5186, f"{d['name']} 좌표계가 EPSG:5186이 아님"
        one["sgg_cd"] = d["code"]
        one["sgg_nm"] = d["name"]
        print(f"  {d['name']:<6} {d['code']}  {len(one):>7,} 필지")
        parts.append(one)
    g = gpd.GeoDataFrame(pd.concat(parts, ignore_index=True), crs=parts[0].crs)
    print(f"  {'합계':<6}          {len(g):>7,} 필지   좌표계 {g.crs.to_string()}")

    # ── T-202 컬럼 매핑 ─────────────────────────────────────────────────
    print("\nT-202  컬럼 매핑")
    missing = set(PARCEL_COLS) - set(g.columns)
    assert not missing, f"원본에 없는 컬럼: {missing}"
    g = g[list(PARCEL_COLS) + ["sgg_cd", "sgg_nm", "geometry"]].rename(columns=PARCEL_COLS)

    g["area_sqm"] = pd.to_numeric(g["area_sqm"], errors="coerce")
    g["price_krw_sqm"] = pd.to_numeric(g["price_krw_sqm"], errors="coerce")

    bad_len = (g["pnu"].str.len() != 19).sum()
    dup = g["pnu"].duplicated().sum()
    wrong_sgg = (g["pnu"].str[:5] != g["sgg_cd"]).sum()
    print(f"  PNU 19자리 아님 : {bad_len:,}")
    print(f"  PNU 중복        : {dup:,}   (자치구 간 포함)")
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

    print("\n  용도지역 분포 (자치구별):")
    ct = pd.crosstab(g["zone1"], g["sgg_nm"])
    ct["합계"] = ct.sum(axis=1)
    for z, row in ct.sort_values("합계", ascending=False).head(10).iterrows():
        cells = "  ".join(f"{c} {row[c]:>6,}" for c in ct.columns[:-1])
        print(f"    {z:<14} {cells}   계 {row['합계']:>6,} ({row['합계'] / len(g):>4.1%})")

    # ── T-206 공시지가 갱신 ─────────────────────────────────────────────
    print("\nT-206  AL_D151 개별공시지가 갱신")
    with zipfile.ZipFile(LANDPRICE_ZIP) as z:
        name = z.namelist()[0]
        with z.open(name) as f:
            lp = pd.read_csv(
                f, encoding=ENCODING, dtype={"고유번호": str},
                usecols=["고유번호", "공시지가", "공시일자", "데이터기준일자"],
            )
    lp = lp[lp["고유번호"].str[:5].isin(codes)]
    lp = lp.drop_duplicates("고유번호").set_index("고유번호")
    print(f"  대상 구 레코드  : {len(lp):,}   공시일자: {lp['공시일자'].mode()[0]}")

    joined = g["pnu"].map(lp["공시지가"])
    joined_date = g["pnu"].map(lp["공시일자"].astype(str))
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
    # 값을 갈아끼웠으면 기준일도 같이 따라가야 한다. 값은 AL_D151 인데
    # 날짜는 AL_D194 의 데이터기준일자를 그대로 두면 둘이 어긋난다
    # (DATA_SOURCES: "둘의 기준일이 다르므로 어느 쪽을 썼는지 기록할 것").
    g["price_ref_date"] = joined_date.fillna(g["price_ref_date"].astype(str))
    print(f"  최종 공시지가 결측/0: {(g['price_krw_sqm'].isna() | g['price_krw_sqm'].eq(0)).sum():,}")
    print(f"  공시일자 분포    : {dict(g['price_ref_date'].value_counts())}")
    # 공시일자는 필지마다 다를 수 있다 (분할·합병 시 수시공시).
    # 검사할 불변식은 "값의 출처와 날짜의 출처가 같은가" 이다.
    valid = set(lp["공시일자"].astype(str))
    from_d151 = g["price_source"].eq("AL_D151_20260526")
    bad = int((from_d151 & ~g["price_ref_date"].isin(valid)).sum())
    assert bad == 0, f"AL_D151 가격인데 날짜가 그 파일에 없는 행 {bad:,}"
    print(f"  값·날짜 출처 일치 : {int(from_d151.sum()):,}행 ✅")

    # ── 저장 ────────────────────────────────────────────────────────────
    INTERIM.mkdir(parents=True, exist_ok=True)
    out = INTERIM / "parcels.gpkg"
    g.to_file(out, driver="GPKG", layer="parcels")
    print(f"\n✅ 저장: {out}  ({len(g):,}행 × {len(g.columns)}컬럼)")


if __name__ == "__main__":
    main()
