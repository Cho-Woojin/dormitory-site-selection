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
    PARCEL_COUNT["total"] = len(g)
    PARCEL_COUNT["by_sgg"] = {str(k): int(v) for k, v in
                              g["sgg_cd"].value_counts().sort_index().items()}

    out = gpd.GeoDataFrame(
        {
            # 식별·표시
            # PNU 19자리 전체를 id 로 쓴다.
            # 시군구를 떼면 자치구 간에 충돌한다 — 법정동 일련번호가 구마다 반복되기
            # 때문이다 (성북+성동 실측 892건 충돌). 5자리 아끼려다 필지가 뒤섞인다.
            "id": g["pnu"],
            "nm": (g["addr"].str.replace("서울특별시 ", "", regex=False)
                   + " " + g["jibun"]),
            "z": g["zone1"].map(ZONE_CODES).fillna(0).astype("int16"),
            "g": g["sgg_cd"].astype("int32"),          # 자치구 코드
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
            # 임대료 지역지수 (D-024). 필지별 임대료 = 기준값 × ri
            "ri": (g["rent_index"] * 10000).round(0).astype("int32"),
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

    # 서울 전역(89.9만 필지)은 한 파일에 못 담는다. 실측 z11-15 221MB 로
    # git 의 파일당 100MB 한도를 넘는다(단순화는 효과 없음 — 용량은 정점 수가
    # 아니라 필지 수가 정한다). 자치구를 필지 수 기준으로 균등 분할한다.
    ngroups = cfg["tiles"]["groups"]
    by_sgg = out["g"].value_counts().sort_values(ascending=False)
    load = [0] * ngroups
    assign = {}
    for code, n in by_sgg.items():          # 큰 구부터 가장 가벼운 그룹에
        k = load.index(min(load))
        assign[int(code)] = k
        load[k] += int(n)
    out["_grp"] = out["g"].astype(int).map(assign)

    paths, groups = [], []
    for k in range(ngroups):
        sub = out[out["_grp"] == k].drop(columns=["_grp"])
        path = INTERIM / f"parcels_web_g{k}.geojson"
        sub.to_file(path, driver="GeoJSON")
        codes = sorted(str(c) for c, v in assign.items() if v == k)
        paths.append(path)
        groups.append({"file": f"parcels_g{k}.pmtiles", "districts": codes,
                       "parcels": int(len(sub))})
        print(f"  그룹 {k}: 자치구 {len(codes):>2}개 · {len(sub):>7,} 필지 "
              f"→ {path.name} {path.stat().st_size / 1e6:,.0f}MB")
    print(f"  속성 {len(out.columns) - 2}개 · {ngroups}개 그룹")
    return paths, groups


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
    # 인덱스를 리셋해야 한다. sjoin 이 돌려주는 인덱스가 곧 배열 위치여야
    # rows 와 adj 의 정합성이 유지된다.
    g = g[(g["flags"] & static) == 0]
    # 타일에 그려지지 않는 자투리는 적격 표에서도 뺀다. 두 산출물이 어긋나면
    # 목록에 뜨는데 지도에서 클릭이 안 되는 필지가 생긴다 (실측 13건).
    amin = cfg["filters"]["min_parcel_area_sqm"]
    tiny = int((g["area_sqm"] < amin).sum())
    g = g[g["area_sqm"] >= amin].reset_index(drop=True)
    print(f"  {amin}㎡ 미만 자투리 제외: {tiny:,} (후보가 될 수 없는 크기)")

    # 필지 중심점 (EPSG:5186 미터). 거점 선정은 필지 간 거리를 재야 하는데
    # 타일 도형에 의존하면 화면 밖 필지를 못 쓴다. 좌표를 직접 싣는다.
    cpt = g.geometry.representative_point()
    # 지도 마커용 위경도. cx/cy 는 미터라 거리 계산에는 맞지만 지도에 못 찍는다.
    # 1e6 배 정수로 실어 소수 오차 없이 왕복시킨다 (~0.1m 해상도).
    wgs = gpd.GeoSeries(cpt, crs=g.crs).to_crs("EPSG:4326")

    # 지형계수 — 합필 시 실현계수를 다시 구하는 데 필요하다.
    # (합필 후 형상계수는 합필 폴리곤에서 새로 계산하고, 지형계수는 최대 필지 것을 쓴다)
    R = cfg["profitability"]["realization"]
    tf = g["terrain"].map(R["slope_factor"]).fillna(R["slope_factor"]["지정되지않음"])

    # 공시일자. 분할·합병 필지는 수시공시라 날짜가 다르다(실측 3종).
    # 문자열을 4만 번 싣지 않고 테이블 + 인덱스로 넣는다.
    price_dates = sorted(g["price_ref_date"].astype(str).unique())
    pd_idx = g["price_ref_date"].astype(str).map({v: i for i, v in enumerate(price_dates)})

    rows = np.column_stack([
        (g["area_sqm"] * 100).round(0).astype("int64"),
        g["far_pct"].fillna(0).astype("int64"),
        (g["realization"] * 100000).round(0).astype("int64"),
        g["price_krw_sqm"].fillna(0).round(0).astype("int64"),
        (g["demo_gfa_sqm"] * 100).round(0).astype("int64"),
        (g["sun"] * 100000).round(0).astype("int64"),
        (g["stn_dist_m"] * 100).round(0).astype("int64"),
        g["flags"].astype("int64"),
        (tf * 1000).round(0).astype("int64"),
        (g["rent_index"] * 10000).round(0).astype("int64"),
        cpt.x.round(0).astype("int64"),
        cpt.y.round(0).astype("int64"),
        (wgs.x * 1000000).round(0).astype("int64"),
        (wgs.y * 1000000).round(0).astype("int64"),
        pd_idx.astype("int64"),
    ]).tolist()

    # 필지명·용도지역도 함께 싣는다. 타일에서 긁어오면 화면 밖 필지의 이름을
    # 못 찾아 리스트에 PNU 가 그대로 노출된다(실제로 발생한 버그).
    print("  연접 관계 계산 중…")
    sj = gpd.sjoin(g[["geometry"]], g[["geometry"]], predicate="touches", how="inner")
    adjacency = [[] for _ in range(len(g))]
    npairs = 0
    for a, b in zip(sj.index, sj["index_right"]):
        a, b = int(a), int(b)
        if a < b:
            adjacency[a].append(b)
            adjacency[b].append(a)
            npairs += 1
    assert max((max(v) for v in adjacency if v), default=-1) < len(g), "인접 인덱스 범위 초과"
    print(f"  연접 쌍 {npairs:,}")

    # 수치 표는 바이너리로 뺀다. JSON 으로 두면 55.9MB 를 브라우저가 파싱해야 하는데,
    # 그 시간 동안 메인 스레드가 막혀 지도 렌더링과 다툰다(라이브 실측 44~78초).
    # 열 우선 + 열별 최소 dtype + 좌표는 델타 → 24MB, gzip 8.9MB, 파싱 비용 0.
    COLS = ["a", "f", "r", "p", "d", "s", "t", "x", "tf", "ri", "cx", "cy", "lon", "lat", "pd"]
    DELTA = {"cx", "cy", "lon", "lat"}      # 인접 필지끼리 값이 붙어 있어 잘 줄어든다
    arr = np.asarray(rows, dtype=np.int64)
    DT = [("u1", np.uint8), ("i2", np.int16), ("i4", np.int32), ("f8", np.int64)]
    schema, chunks = [], []
    for i, c in enumerate(COLS):
        col = arr[:, i]
        if c in DELTA:
            # prepend=0 이어야 한다. col[0] 을 넣으면 첫 값이 0 이 되어
            # 누적합이 기준점을 잃는다 (좌표가 통째로 어긋났다).
            col = np.diff(col, prepend=0)
        for code, dt in DT:
            info = np.iinfo(dt)
            if col.min() >= info.min and col.max() <= info.max:
                break
        chunks.append(col.astype(dt).tobytes())
        schema.append({"c": c, "t": code, "d": c in DELTA})
    binpath = WEB_DATA / "scoring.bin"
    binpath.write_bytes(b"".join(chunks))

    payload = {
        "cols": COLS,
        "bin": {"file": "scoring.bin", "n": len(g), "schema": schema},
        "price_dates": price_dates,     # pd 열이 가리키는 공시일자
        # 필지명·자치구코드는 싣지 않는다. PNU 로 정확히 복원된다
        # (89.9만 건 전수 대조 불일치 0). 이름을 그대로 실으면 24MB,
        # 법정동 이름표는 467개 18KB 다.
        #   PNU[0:5]  = 자치구코드
        #   PNU[0:10] = 법정동코드 → 이름표
        #   PNU[11:15] 본번 / [15:19] 부번 → "800-20" (부번 0 이면 본번만)
        "bjd_names": dict(g.assign(
            _b=g["pnu"].str[:10],
            _d=g["addr"].str.replace("서울특별시 ", "", regex=False))
            .groupby("_b")["_d"].first()),
        "ids": g["pnu"].tolist(),
        "z": g["zone1"].map(ZONE_CODES).fillna(0).astype(int).tolist(),
    }
    path = WEB_DATA / "scoring.json"
    path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"  scoring.json      {len(g):,}행  {path.stat().st_size / 1e6:.2f}MB (id·이름표)")
    print(f"  scoring.bin       수치 {len(COLS)}열  {binpath.stat().st_size / 1e6:.2f}MB")

    # 연접 관계는 합필 모드에서만 쓴다. 첫 화면에 11MB 를 지울 이유가 없으므로
    # 별도 파일로 빼고 합필 모드를 켤 때 받는다. rows 와 같은 인덱스를 쓴다.
    apath = WEB_DATA / "adjacency.json"
    apath.write_text(json.dumps({"n": len(g), "adj": adjacency},
                                separators=(",", ":")), encoding="utf-8")
    print(f"  adjacency.json    연접 {npairs:,}쌍  {apath.stat().st_size / 1e6:.2f}MB (지연 로드)")


def build_tiles(cfg, geojsons, groups):
    """T-402 — tippecanoe 로 PMTiles 생성. 그룹마다 한 파일."""
    if not shutil.which("tippecanoe"):
        print("  ⚠️ tippecanoe 미설치 — `brew install tippecanoe` 후 재실행")
        return None
    T = cfg["tiles"]
    total = 0
    for gj, grp in zip(geojsons, groups):
        out = WEB_DATA / grp["file"]
        total += _tippecanoe(T, gj, out)
    print(f"  합계 {total:.1f}MB")
    return groups


def _tippecanoe(T, geojson, out):
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "tippecanoe", "-o", str(out), "--force",
        "-l", "parcels",
        "-Z", str(T["min_zoom"]), "-z", str(T["max_zoom"]),
        # 필지는 하나도 빠지면 안 된다 — 점수 재계산 대상이므로
        "--no-feature-limit", "--no-tile-size-limit",
        "--drop-densest-as-needed",          # 저줌에서만 솎아낸다
        "--coalesce-densest-as-needed",
        # 0.4㎡ 짜리 자투리 필지도 남긴다. 기본값은 최대줌에서도 이런 도형을
        # 솎아내는데, 그러면 scoring.json 에는 있고 지도에는 없는 필지가 생긴다
        # (실측 73건). 목록에 뜨는데 클릭이 안 되는 상태가 된다.
        "--no-tiny-polygon-reduction",
        "--simplification=4",
        str(geojson),
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr[-1500:])
        raise SystemExit("tippecanoe 실패")
    mb = out.stat().st_size / 1e6
    ok = "✅" if mb <= T["max_size_mb"] else "❌ 용량 초과"
    print(f"  → {out.name}  {mb:.1f}MB (상한 {T['max_size_mb']}MB) {ok}")
    if mb > T["max_size_mb"]:
        raise SystemExit(f"{out.name} {mb:.1f}MB > 상한 {T['max_size_mb']}MB — "
                         f"tiles.groups 를 늘리세요")
    return mb


PARCEL_COUNT = {"total": 0, "by_sgg": {}}


def export_aux(cfg, groups):
    # export_parcels() 가 채우는 전역이다. 단독 실행하면 0 이 그대로 meta 에
    # 실려 헤더가 "0 필지" 가 된다. 조용히 틀린 값을 쓰느니 멈춘다.
    assert PARCEL_COUNT["total"] > 0, \
        "PARCEL_COUNT 가 비었다 — export_parcels() 를 먼저 실행할 것"
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
    codes = [d["code"] for d in cfg["region"]["districts"]]
    gu = sgg[sgg["sgg_cd"].astype(str).isin(codes)].to_crs(crs)
    # sgg_cd 를 반드시 함께 내보낸다. 웹이 자치구 코드로 경계를 찾아 지도를
    # 옮기는데, 이름만 있으면 전부 undefined 키로 덮여 한 개만 남는다
    # (2개 구 시절부터 자치구 선택 시 지도가 움직이지 않았다).
    gu = gu.copy()
    gu["sgg_cd"] = gu["sgg_cd"].astype(str)
    out_b = WEB_DATA / "boundary.geojson"
    gu[["sgg_cd", "sgg_nm", "geometry"]].to_file(out_b, driver="GeoJSON")
    got = json.loads(out_b.read_text(encoding="utf-8"))
    keys = {f["properties"].get("sgg_cd") for f in got["features"]}
    assert keys == set(codes), f"경계 sgg_cd 불일치: {len(keys)}개 vs {len(codes)}개"
    print(f"  boundary.geojson  {len(got['features'])}개 자치구  "
          f"{out_b.stat().st_size / 1e3:.0f}KB")

    # 기준연도는 손으로 적지 않는다. 손으로 적은 값은 데이터가 바뀌어도
    # 따라오지 않는다 (실제로 공시지가 출처가 AL_D151 로 바뀐 뒤에도
    # AL_D194 날짜가 그대로 남아 있었다).
    gp = gpd.read_file(INTERIM / "parcels_ranked.gpkg", layer="parcels",
                       columns=["price_ref_date", "price_source"], ignore_geometry=True)
    valid = gp[gp["price_source"].eq("AL_D151_20260526")]
    dates = valid["price_ref_date"].astype(str).value_counts()
    # 출처 줄에 들어가므로 짧게. 대표 공시일자 + 나머지 건수.
    main_d, main_n = dates.index[0], int(dates.iloc[0])
    rest = int(dates.iloc[1:].sum())
    price_vintage = (f"공시일자 {main_d}"
                     + (f" (분할·합병 수시공시 {rest:,}필지는 별도)" if rest else ""))

    # 임대료 지수 요약. 사용자가 고른 자치구에서 기준값이 얼마가 되는지
    # 화면에 바로 보여 주려면 필요하다.
    rent_base = cfg["region"].get("rent_index_base", cfg["region"]["districts"][0]["code"])
    rm = json.loads((INTERIM / "rent_market.json").read_text(encoding="utf-8"))
    rent_by_sgg = {k: round(v["index"], 3) for k, v in rm["by_sgg"].items()}
    rent_dong_span = {}
    for key, v in rm["by_dong"].items():
        code = key.split("|")[0]
        lo, hi = rent_dong_span.get(code, (v["index"], v["index"]))
        rent_dong_span[code] = (min(lo, v["index"]), max(hi, v["index"]))
    rent_dong_span = {k: [round(a, 3), round(b, 3)] for k, (a, b) in rent_dong_span.items()}
    assert rent_base in rent_by_sgg, f"기준 자치구 {rent_base} 지수가 없다"
    assert abs(rent_by_sgg[rent_base] - 1.0) < 1e-6, \
        f"기준 자치구 지수가 1.0 이 아니다: {rent_by_sgg[rent_base]}"

    # 웹이 점수를 재계산하려면 파라미터 기본값과 코드표가 필요하다
    P, F, S, T, R = (cfg["profitability"], cfg["filters"], cfg["solar"],
                     cfg["transit"], cfg["ranking"])
    meta = {
        "region": cfg["region"]["name"],
        "districts": [{"code": d["code"], "name": d["name"]}
                      for d in cfg["region"]["districts"]],
        "parcel_count": PARCEL_COUNT["total"],
        "parcel_count_by_district": PARCEL_COUNT["by_sgg"],
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
        "scale": {"a": 100, "r": 100000, "p": 1, "d": 100, "s": 100000, "t": 100, "tf": 1000, "ri": 10000, "cx": 1, "cy": 1, "lon": 1000000, "lat": 1000000, "pd": 1},
        "flag_bits": {
            "F_JIMOK": 1, "F_ZONE": 2, "F_LANDUSE": 4, "F_ROAD": 8,
            "F_ROOMS": 16, "F_PRICE": 32,
            "W_ROAD_UNKNOWN": 256, "W_ZONE2": 512, "W_SUBDIVIDED": 1024,
            "W_INDUSTRIAL": 2048,
        },
        # 기준 자치구는 params 가 정한다. districts[0] 을 쓰면 목록을 정렬하는
        # 것만으로 기준이 바뀐다 (실제로 성북구 → 종로구가 됐다).
        "rent_index": {
            "enabled": bool(cfg["profitability"].get("use_rent_index", False)),
            "base_district": rent_base,
            "base_district_name": next(
                (d["name"] for d in cfg["region"]["districts"] if d["code"] == rent_base),
                rent_base),
            "n_transactions": int(rm["n_transactions"]),
            "n_dong": len(rm["by_dong"]),
            "years": rm.get("years", []),
            "by_sgg": rent_by_sgg,          # 화면에서 "이 구의 적용 임대료" 를 보여 준다
            "dong_span": rent_dong_span,    # 자치구 안 법정동 지수 범위
            "note": "필지별 임대료 = monthly_rent_per_room × ri",
        },
        "hubs": {
            "default_min_spacing_m": 1000,
            "note": "거점 간 최소 이격. 상위 후보는 한 블록에 몰려 카니발라이제이션이 생긴다",
        },
        "assembly": {
            "district_plan_threshold_sqm": 3000,
            "industrial_zones": ["준공업지역", "전용공업지역", "일반공업지역"],
            "shape_factor_base": 0.70,
            "shape_factor_span": 0.32,
            "realization_base": cfg["profitability"]["realization"]["base"],
        },
        "tile_groups": groups,     # 타일 파일과 담당 자치구
        # 지도 minZoom 을 여기에 맞춘다. 어긋나면 축소했을 때 필지가 사라진다.
        "tiles_min_zoom": cfg["tiles"]["min_zoom"],
        "data_vintage": {
            "필지": "2026-05-13 (AL_D194 토지특성정보)",
            "개별공시지가": f"AL_D151 · {price_vintage}",
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
    gjs, groups = export_parcels(cfg)

    print("\n" + "═" * 62)
    print("T-402  PMTiles 생성")
    build_tiles(cfg, gjs, groups)

    print("\n" + "═" * 62)
    print("T-403  부가 레이어")
    export_scoring_table(cfg)
    export_aux(cfg, groups)
    print("\n✅ 완료")


if __name__ == "__main__":
    main()
