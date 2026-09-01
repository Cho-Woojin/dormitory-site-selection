"""T-401 ~ T-403 — 웹 배포용 데이터 내보내기.

  T-401  raw 속성만 담은 GeoJSON (EPSG:4326)
  T-402  tippecanoe → web/data/parcels.pmtiles
  T-403  역·구경계 GeoJSON

핵심 제약 (D-003): **사전 계산된 점수·순위를 넣지 않는다.**
브라우저가 raw 값에서 S₁~S₃ 와 계층 정렬을 재계산한다.
점수를 구워 넣으면 파라미터 슬라이더가 동작하지 않는다.

정수로 반올림해 내보낸다 — 벡터타일에서 정수가 실수보다 훨씬 잘 압축된다.
"""
import json
import shutil
import subprocess

import geopandas as gpd
import numpy as np

from common import INTERIM, RAW, ROOT, load_config

WEB_DATA = ROOT / "web" / "data"

# 용도지역 → 짧은 코드 (타일 용량 절감). 웹에서 역매핑한다.
ZONE_CODES = {
    "제1종전용주거지역": 1, "제2종전용주거지역": 2,
    "제1종일반주거지역": 3, "제2종일반주거지역": 4, "제3종일반주거지역": 5,
    "준주거지역": 6, "근린상업지역": 7, "일반상업지역": 8,
    "중심상업지역": 9, "유통상업지역": 10, "준공업지역": 11,
    "전용공업지역": 12, "일반공업지역": 13,
    "자연녹지지역": 14, "생산녹지지역": 15, "보전녹지지역": 16, "개발제한구역": 17,
}


def export_parcels(cfg):
    """T-401 — raw 지표만 담은 GeoJSON."""
    g = gpd.read_file(INTERIM / "parcels_ranked.gpkg", layer="parcels")
    print(f"  입력 {len(g):,} 필지")

    out = gpd.GeoDataFrame(
        {
            # 식별·표시
            # PNU 19자리 = 시군구5 + 법정동5 + 특수지1 + 본번4 + 부번4.
            # 성북구 단일 분석이라 시군구 5자리는 상수 → 제거. `"11290" + id` 로 복원된다.
            # 주의: 뒤 8자리(본번+부번)만 쓰면 법정동이 다른 필지끼리 충돌한다 (실측 15,322건).
            "id": g["pnu"].str[5:],
            "nm": (g["addr"].str.replace("서울특별시 성북구 ", "", regex=False)
                   + " " + g["jibun"]),
            "z": g["zone1"].map(ZONE_CODES).fillna(0).astype("int16"),
            # S₁ 재계산에 필요한 raw 값
            #
            # ⚠️ 정밀도 주의: 실 수는 floor(), 역세권은 등급 경계로 끊기므로
            # 입력이 조금만 어긋나도 결과가 한 칸씩 튄다. 실제 측정값:
            #   천원절사 + rf×1000  → S₁ 오차 6.6%p, 상위200 순서 114/200
            #   ×10  / rf×10000     → 실수 19건·등급 10건 불일치
            #   ×100 / rf×100000    → 불일치 0 ← 채택
            # 용량보다 정확도가 우선이다. 어긋나면 웹이 조용히 틀린 답을 보여준다.
            "a": (g["area_sqm"] * 100).round(0).astype("int64"),   # 필지면적 ×100
            "f": g["far_pct"].fillna(0).astype("int16"),           # 적용용적률 % (이미 정수)
            "r": (g["realization"] * 100000).round(0).astype("int32"),  # 실현계수 ×100000
            "p": g["price_krw_sqm"].fillna(0).round(0).astype("int32"),  # 원/㎡ (절사 금지)
            "d": (g["demo_gfa_sqm"] * 100).round(0).astype("int64"),  # 철거 연면적 ×100
            # S₂ (기하 기반, 파라미터 무관하므로 사전계산)
            "s": (g["sun"] * 100000).round(0).astype("int32"),     # 일조 ×100000
            # S₃ raw (등급 임계값은 웹 파라미터)
            "t": (g["stn_dist_m"] * 100).round(0).astype("int64"),  # 최근접역 거리 ×100
            # 하드필터·경고 비트마스크
            "x": g["flags"].astype("int32"),
            "geometry": g.geometry,
        },
        crs=g.crs,
    ).to_crs(cfg["region"]["output_crs"])

    assert "rank" not in out.columns and "s1_net_equity" not in out.columns, \
        "점수·순위가 타일에 들어가면 안 된다 (D-003)"
    dup = len(out) - out["id"].nunique()
    assert dup == 0, f"id 중복 {dup:,}건 — 웹이 필지를 구분하지 못한다"

    WEB_DATA.mkdir(parents=True, exist_ok=True)
    path = INTERIM / "parcels_web.geojson"
    out.to_file(path, driver="GeoJSON")
    mb = path.stat().st_size / 1e6
    print(f"  속성 {len(out.columns) - 1}개 → {path.name}  {mb:,.0f}MB")
    return path


def export_scoring_table(cfg):
    """브라우저가 전역 순위를 계산하려면 후보 전체의 raw 값이 필요하다.

    벡터타일은 화면에 보이는 타일만 로드되므로 백분위 밴드(전역 순위)를
    타일만으로는 계산할 수 없다. 별도의 경량 표를 함께 싣는다.

    주의: 후보 판정 F5(최소 실 수)는 파라미터에 의존하므로 동적이다.
    따라서 **F5를 뺀 나머지 필터를 통과한 필지 전부**를 담아야
    min_rooms 슬라이더가 올바르게 동작한다.
    """
    from common import F_JIMOK, F_LANDUSE, F_PRICE, F_ROAD, F_ZONE

    g = gpd.read_file(INTERIM / "parcels_ranked.gpkg", layer="parcels")
    static = F_JIMOK | F_ZONE | F_LANDUSE | F_ROAD | F_PRICE
    g = g[(g["flags"] & static) == 0].copy()

    rows = np.column_stack([
        (g["area_sqm"] * 100).round(0).astype("int64"),
        g["far_pct"].fillna(0).astype("int64"),
        (g["realization"] * 100000).round(0).astype("int64"),
        g["price_krw_sqm"].fillna(0).round(0).astype("int64"),
        (g["demo_gfa_sqm"] * 100).round(0).astype("int64"),
        (g["sun"] * 100000).round(0).astype("int64"),
        (g["stn_dist_m"] * 100).round(0).astype("int64"),
        g["flags"].astype("int64"),
    ]).tolist()

    # 필지명·용도지역도 함께 싣는다. 타일에서 긁어오면 화면 밖 필지의 이름을
    # 못 찾아 리스트에 PNU 가 그대로 노출된다(실제로 발생한 버그).
    payload = {
        "cols": ["a", "f", "r", "p", "d", "s", "t", "x"],
        "ids": g["pnu"].str[5:].tolist(),
        "nm": (g["addr"].str.replace("서울특별시 성북구 ", "", regex=False)
               + " " + g["jibun"]).tolist(),
        "z": g["zone1"].map(ZONE_CODES).fillna(0).astype(int).tolist(),
        "rows": rows,
    }
    path = WEB_DATA / "scoring.json"
    path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"  scoring.json      {len(g):,}행  "
          f"{path.stat().st_size / 1e6:.2f}MB (F5 제외 필터 통과분)")


def build_tiles(cfg, geojson):
    """T-402 — tippecanoe 로 PMTiles 생성."""
    if not shutil.which("tippecanoe"):
        print("  ⚠️ tippecanoe 미설치 — `brew install tippecanoe` 후 재실행")
        return None
    T = cfg["tiles"]
    out = ROOT / T["output"]
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "tippecanoe", "-o", str(out), "--force",
        "-l", "parcels",
        "-Z", str(T["min_zoom"]), "-z", str(T["max_zoom"]),
        # 필지는 하나도 빠지면 안 된다 — 점수 재계산 대상이므로
        "--no-feature-limit", "--no-tile-size-limit",
        "--drop-densest-as-needed",          # 저줌에서만 솎아낸다
        "--coalesce-densest-as-needed",
        "--simplification=4",
        str(geojson),
    ]
    print(f"  $ {' '.join(cmd[:8])} …")
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr[-1500:])
        raise SystemExit("tippecanoe 실패")
    mb = out.stat().st_size / 1e6
    ok = "✅" if mb <= T["max_size_mb"] else "❌ 용량 초과"
    print(f"  → {out.relative_to(ROOT)}  {mb:.1f}MB (상한 {T['max_size_mb']}MB) {ok}")
    return out


def export_aux(cfg):
    """T-403 — 역·구경계. 소형이라 타일 불필요."""
    crs = cfg["region"]["output_crs"]

    st = gpd.read_file(INTERIM / "stations.gpkg", layer="stations").to_crs(crs)
    st = st[["name", "line", "in_gu", "geometry"]]
    st.to_file(WEB_DATA / "stations.geojson", driver="GeoJSON")
    print(f"  stations.geojson  {len(st)}개  "
          f"{(WEB_DATA / 'stations.geojson').stat().st_size / 1e3:.0f}KB")

    sgg = gpd.read_file(
        RAW / "external" / "seoul_admin_boundaries" / "seoul_sgg.geojson"
    )
    gu = sgg[sgg["sgg_cd"].astype(str) == cfg["region"]["sgg_code"]].to_crs(crs)
    gu[["sgg_nm", "geometry"]].to_file(WEB_DATA / "boundary.geojson", driver="GeoJSON")
    print(f"  boundary.geojson  {(WEB_DATA / 'boundary.geojson').stat().st_size / 1e3:.0f}KB")

    # 웹이 점수를 재계산하려면 파라미터 기본값과 코드표가 필요하다
    P, F, S, T, R = (cfg["profitability"], cfg["filters"], cfg["solar"],
                     cfg["transit"], cfg["ranking"])
    meta = {
        "region": cfg["region"]["name"],
        "parcel_count": 52970,
        "zone_codes": {str(v): k for k, v in ZONE_CODES.items()},
        "zone_far": {str(ZONE_CODES[k]): (v["far_residential"] or
                                          (v["far_relaxed"] or v["far"]))
                     for k, v in cfg["zoning"]["zones"].items() if k in ZONE_CODES},
        "defaults": {
            "land_price_multiplier": P["land_price_multiplier"],
            "unit_construction_cost": P["unit_construction_cost"],
            "soft_cost_ratio": P["soft_cost_ratio"],
            "demolition_cost_per_sqm": P["demolition_cost_per_sqm"],
            "net_area_ratio": P["net_area_ratio"],
            "room_area_sqm": P["room_area_sqm"],
            "monthly_rent_per_room": P["monthly_rent_per_room"],
            "deposit_per_room": P["deposit_per_room"],
            "vacancy_rate": P["vacancy_rate"],
            "opex_ratio": P["opex_ratio"],
            "min_rooms": F["min_rooms"],
            "grades": T["grades"],
            "tol_profitability_pct": R["tol_profitability_pct"],
            "tol_solar_pct": R["tol_solar_pct"],
        },
        "scale": {"a": 100, "r": 100000, "p": 1, "d": 100, "s": 100000, "t": 100},
        "flag_bits": {
            "F_JIMOK": 1, "F_ZONE": 2, "F_LANDUSE": 4, "F_ROAD": 8,
            "F_ROOMS": 16, "F_PRICE": 32,
            "W_ROAD_UNKNOWN": 256, "W_ZONE2": 512, "W_SUBDIVIDED": 1024,
        },
        "data_vintage": {
            "필지·공시지가": "2026-05-13 (AL_D194) / 공시일자 2026-04-30",
            "건물": "2026-08-09 (AL_D010)",
            "조례": "서울시 도시계획조례 시행 2026-07-13",
        },
    }
    (WEB_DATA / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"  meta.json         {(WEB_DATA / 'meta.json').stat().st_size / 1e3:.0f}KB")


def main():
    cfg = load_config()
    print("═" * 62)
    print("T-401  필지 GeoJSON 내보내기 (raw 속성만)")
    gj = export_parcels(cfg)

    print("\n" + "═" * 62)
    print("T-402  PMTiles 생성")
    build_tiles(cfg, gj)

    print("\n" + "═" * 62)
    print("T-403  부가 레이어")
    export_scoring_table(cfg)
    export_aux(cfg)
    print("\n✅ 완료")


if __name__ == "__main__":
    main()
