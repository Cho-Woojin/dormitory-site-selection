"""T-104, T-304 — 지하철역 수집 + 역세권 등급 (S₃).

  T-104  서울 열린데이터광장에서 역 좌표 수집, 성북구 + 버퍼 1.5km 로 필터
  T-304  최근접역 직선거리 → 계단식 등급 A~E

거리 계산은 EPSG:5186 에서 한다. 위경도로 거리를 재면 안 된다.
출력: data/interim/stations.gpkg, parcels_s3.gpkg
"""
import os

import geopandas as gpd
import numpy as np
import pandas as pd
import requests
from dotenv import load_dotenv

from common import INTERIM, RAW, ROOT, load_config

API = "http://openapi.seoul.go.kr:8088/{key}/json/subwayStationMaster/1/1000/"


def fetch_stations(cfg):
    """T-104 — 역 마스터 수집 후 성북구 버퍼로 공간 필터."""
    load_dotenv(ROOT / ".env")
    key = os.environ.get("SEOUL_OPENAPI_KEY")
    if not key:
        raise SystemExit(".env 에 SEOUL_OPENAPI_KEY 가 없습니다")

    cache = INTERIM / "_stations_raw.json"
    if cache.exists():
        rows = pd.read_json(cache).to_dict("records")
        print(f"  캐시 사용: {len(rows):,}건")
    else:
        r = requests.get(API.format(key=key), timeout=30)
        r.raise_for_status()
        body = r.json()["subwayStationMaster"]
        if body["RESULT"]["CODE"] != "INFO-000":
            raise SystemExit(f"API 오류: {body['RESULT']}")
        rows = body["row"]
        print(f"  수신: {len(rows):,} / 전체 {body['list_total_count']:,}건")
        pd.DataFrame(rows).to_json(cache, orient="records", force_ascii=False)

    df = pd.DataFrame(rows).rename(
        columns={"BLDN_NM": "name", "ROUTE": "line", "LAT": "lat", "LOT": "lon"}
    )
    df[["lat", "lon"]] = df[["lat", "lon"]].apply(pd.to_numeric, errors="coerce")
    df = df.dropna(subset=["lat", "lon"])

    st = gpd.GeoDataFrame(
        df, geometry=gpd.points_from_xy(df["lon"], df["lat"]), crs="EPSG:4326"
    ).to_crs(cfg["region"]["analysis_crs"])

    # 대상 구 경계 + 버퍼 — 구 밖 역이 구 안 필지의 등급을 정하는 경우가 많다
    codes = [d["code"] for d in cfg["region"]["districts"]]
    sgg = gpd.read_file(
        RAW / "external" / "seoul_admin_boundaries" / "seoul_sgg.geojson"
    ).to_crs(st.crs)
    gu = sgg[sgg["sgg_cd"].astype(str).isin(codes)]
    if len(gu) != len(codes):
        raise SystemExit(f"경계에서 시군구 {codes} 를 다 못 찾음 (찾은 수 {len(gu)})")
    inner = gu.geometry.union_all()
    buf = inner.buffer(cfg["region"]["station_buffer_m"])

    st["in_gu"] = st.within(inner)
    near = st[st.within(buf)].copy()
    print(f"  대상 구 내 {int(near['in_gu'].sum())}개 + 버퍼 "
          f"{cfg['region']['station_buffer_m']}m 내 {len(near) - int(near['in_gu'].sum())}개"
          f" = {len(near)}개")
    return near


def main():
    cfg = load_config()
    crs = cfg["region"]["analysis_crs"]

    print("═" * 62)
    print("T-104  지하철역 수집")
    st = fetch_stations(cfg)

    # 같은 역이 노선별로 중복 → 이름+좌표로 통합 (환승역은 1개 지점)
    st["key"] = st["name"] + "|" + st.geometry.x.round(0).astype(int).astype(str)
    lines = st.groupby("key")["line"].apply(lambda s: ",".join(sorted(set(s))))
    st = st.drop_duplicates("key").set_index("key")
    st["line"] = lines
    st = st.reset_index(drop=True)
    print(f"  중복 노선 통합 후: {len(st)}개 지점")
    inn = st[st["in_gu"]].sort_values("name")
    print(f"\n  대상 구 내 역 {len(inn)}개:")
    for _, r in inn.iterrows():
        print(f"    {r['name']:<22} {r['line']}")

    INTERIM.mkdir(parents=True, exist_ok=True)
    st.to_file(INTERIM / "stations.gpkg", driver="GPKG", layer="stations")

    # ── T-304 역세권 등급 ───────────────────────────────────────────────
    print("\n" + "═" * 62)
    print("T-304  역세권 등급")
    g = gpd.read_file(INTERIM / "parcels_s1.gpkg", layer="parcels")
    assert g.crs.to_string() == crs, f"필지 좌표계가 {crs} 가 아님: {g.crs}"

    # 필지 대표점 → 최근접역. sjoin_nearest 는 STRtree 색인을 쓴다 (행 루프 금지)
    pts = g.copy()
    pts["geometry"] = g.geometry.representative_point()
    nearest = gpd.sjoin_nearest(
        pts[["geometry"]], st[["name", "line", "geometry"]],
        how="left", distance_col="stn_dist_m",
    )
    nearest = nearest[~nearest.index.duplicated()]  # 동거리 동점 시 첫 역 채택
    g["stn_name"] = nearest["name"].values
    g["stn_line"] = nearest["line"].values
    # 타일은 거리를 ×100 정수로 싣는다. 원본을 그 정밀도로 확정해 두지 않으면
    # 경계에 걸친 필지(예: 250.0024m)가 타일에서 250.00m 로 반올림되며
    # 등급이 한 칸 어긋난다 (실측 16건). 저장 정밀도가 값의 정의다.
    g["stn_dist_m"] = np.round(nearest["stn_dist_m"].values, 2)

    grades = cfg["transit"]["grades"]
    bounds = [grades["A"], grades["B"], grades["C"], grades["D"]]
    g["stn_grade"] = pd.cut(
        g["stn_dist_m"], bins=[-np.inf, *bounds, np.inf],
        labels=["A", "B", "C", "D", "E"], right=True,
    ).astype(str)

    c = g[g["is_candidate"]]
    print(f"\n  임계값: A≤{bounds[0]} B≤{bounds[1]} C≤{bounds[2]} D≤{bounds[3]} E>{bounds[3]} (m)")
    print(f"\n  {'등급':<6}{'전체':>10}{'후보':>10}")
    for gr in ["A", "B", "C", "D", "E"]:
        print(f"  {gr:<6}{int((g['stn_grade'] == gr).sum()):>10,}"
              f"{int((c['stn_grade'] == gr).sum()):>10,}")
    print(f"\n  후보 역거리 중위: {c['stn_dist_m'].median():,.0f}m")

    # 완료조건 — 역 반경 250m 내 필지는 전부 A등급이어야 한다.
    # 거리는 **필지 대표점** 기준으로 정의된다. 폴리곤 경계로 재면 항상 더 짧게
    # 나와 등급과 어긋나므로, 검증도 같은 기준을 써야 한다.
    # 역명에 괄호 부기가 붙으므로(예: 한성대입구(삼선교)) 접두 일치로 찾는다.
    rp = g.geometry.representative_point()
    for stn in ["한성대입구", "고려대", "길음", "왕십리", "성수"]:
        hit = st[st["name"].str.startswith(stn)]
        assert len(hit), f"'{stn}' 역을 수집 결과에서 못 찾음"
        near = g[rp.distance(hit.geometry.iloc[0]) <= grades["A"]]
        bad = int((near["stn_grade"] != "A").sum())
        print(f"  검증: {hit.iloc[0]['name']:<18} {grades['A']}m 내 {len(near):>4,}필지"
              f" 중 A등급 아님 {bad}건  {'✅' if bad == 0 else '❌'}")
        assert bad == 0, f"{stn} 반경 내 필지가 A등급이 아님 — 거리 계산 확인 필요"

    out = INTERIM / "parcels_s3.gpkg"
    g.to_file(out, driver="GPKG", layer="parcels")
    print(f"\n✅ 저장: {out}")


if __name__ == "__main__":
    main()
