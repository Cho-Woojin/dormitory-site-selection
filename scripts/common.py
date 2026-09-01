"""공통 설정·경로·컬럼 매핑.

컬럼명은 브이월드 "국가중점데이터 컬럼정의서" 원문을 따른다.
추측하지 말 것 — data/raw/land_characteristics/컬럼정의서.xlsx 참조.
"""
from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
INTERIM = ROOT / "data" / "interim"

LAND_DIR = RAW / "land_characteristics"
BUILDINGS_SHP = RAW / "GIS건물통합정보_서울" / "AL_D010_11_20260809.shp"


def parcel_shp(d):
    """자치구 하나의 토지특성정보 SHP 경로."""
    return LAND_DIR / d["code"] / f'{d["shp"]}.shp'
LANDPRICE_ZIP = RAW / "officially_assessed_price" / "AL_D151_11_20260526 (3).zip"

# 두 SHP 모두 CP949. AL_D194는 .cpg가 UTF-8로 잘못 표기돼 있고,
# AL_D010은 .cpg가 아예 없어 pyogrio가 ISO-8859-1로 오추정한다.
ENCODING = "cp949"

# AL_D194 토지특성정보 — 쓰는 컬럼만
PARCEL_COLS = {
    "A1": "pnu",            # 고유번호 (19자리)
    "A3": "addr",           # 법정동명
    "A6": "jibun",          # 지번
    "A11": "jimok",         # 지목명
    "A12": "area_sqm",      # 토지면적(㎡)
    "A14": "zone1",         # 용도지역명1
    "A16": "zone2",         # 용도지역명2 — 두 용도지역에 걸친 필지
    "A18": "landuse",       # 토지이용상황명
    "A20": "terrain",       # 지형높이명 (평지/완경사/급경사/고지/저지)
    "A22": "land_shape",    # 지형형상명 (정방형/사다리형/부정형/자루형 …)
    "A24": "road_side",     # 도로측면명 (광대로한면/세로한면(불)/맹지 …)
    "A25": "price_krw_sqm", # 공시지가 (원/㎡)
    "A26": "price_ref_date",# 데이터기준일자
}

# AL_D010 GIS건물통합정보 — 쓰는 컬럼만
BUILDING_COLS = {
    "A2": "pnu",
    "A4": "addr",
    "A9": "bld_use",        # 건축물용도명
    "A16": "height_m",      # 높이(m)
    "A23": "sgg_cd",        # 원천시도시군구코드
    "A26": "floors_up",     # 지상층_수
    "A27": "floors_dn",     # 지하층_수
}

# 하드 필터 비트마스크 (METHODOLOGY §1)
F_JIMOK = 1 << 0    # F6 지목이 '대'가 아님
F_ZONE = 1 << 1     # F1 용도지역에서 공동주택 불가
F_LANDUSE = 1 << 2  # F3 토지이용상황이 매입·건축 불가
F_ROAD = 1 << 3     # F4 자동차 통행 불가 또는 맹지
F_ROOMS = 1 << 4    # F5 20실 미만
F_PRICE = 1 << 5    # 공시지가 결측/0 — 사업성 계산 불가
W_ROAD_UNKNOWN = 1 << 8  # 경고: 도로측면 '지정되지않음' (제외는 안 함, Q-07)
W_ZONE2 = 1 << 9         # 경고: 용도지역 2개에 걸침 (zone1을 채택)
W_SUBDIVIDED = 1 << 10   # 경고: 구분소유 추정 (다세대) — 전 세대 동의 필요 (D-014)
W_INDUSTRIAL = 1 << 11   # 경고: 준공업·공업지역 — 산업기능 보호 규제 확인 필요 (D-018)

FILTER_LABELS = [
    (F_JIMOK, "F6 지목≠대"),
    (F_ZONE, "F1 용도지역 불가"),
    (F_LANDUSE, "F3 토지이용상황"),
    (F_ROAD, "F4 접도 불가"),
    (F_PRICE, "   공시지가 결측"),
    (F_ROOMS, "F5 20실 미만"),
]


def region_mask(gdf, cfg, buffer_m=0):
    """대상 자치구(+버퍼) 안에 드는 행만 True. 경계는 SGIS 를 쓴다."""
    import geopandas as gpd

    codes = [d["code"] for d in cfg["region"]["districts"]]
    sgg = gpd.read_file(
        RAW / "external" / "seoul_admin_boundaries" / "seoul_sgg.geojson"
    ).to_crs(gdf.crs)
    poly = sgg[sgg["sgg_cd"].astype(str).isin(codes)].geometry.union_all()
    if buffer_m:
        poly = poly.buffer(buffer_m)
    return gdf.geometry.representative_point().within(poly)


def district_name(cfg, code):
    for d in cfg["region"]["districts"]:
        if d["code"] == code:
            return d["name"]
    return code


def load_config():
    with open(ROOT / "config" / "params.yaml", encoding="utf-8") as f:
        return yaml.safe_load(f)


def applied_far(cfg):
    """용도지역명 → 임대형기숙사에 적용할 용적률(%).

    1) 2025 한시완화 스위치 반영 (D-005)
    2) 주거용 용적률 상한으로 클램프 (D-011)
       상업지역은 조례상 주거용 400% 이하. 이걸 빼면 상업지역이 순위를 독식한다.
    """
    relaxed = cfg["zoning"]["relaxation_2025"]["enabled"]
    out = {}
    for name, v in cfg["zoning"]["zones"].items():
        far = (v["far_relaxed"] or v["far"]) if relaxed else v["far"]
        cap = v.get("far_residential")
        out[name] = min(far, cap) if cap is not None else far
    return out


def load_buildings(cfg, verbose=True):
    """성북구 건물 + 높이 3단계 폴백 (T-204, D-012). 결과를 interim에 캐시한다.

    사업성(철거비)과 일조 양쪽에서 쓰므로 공유한다.
      1) A16 실측 높이
      2) A26 지상층수 × 층고
      3) 폴리곤 바닥면적 구간별 중위 층수 × 층고
    """
    import geopandas as gpd
    import numpy as np
    import pandas as pd

    cache = INTERIM / "buildings.gpkg"
    codes = [d["code"] for d in cfg["region"]["districts"]]
    if cache.exists():
        b = gpd.read_file(cache, layer="buildings")
        cached = set(b["sgg_cd"].astype(str).unique())
        # 캐시가 설정과 어긋나면 조용히 쓰면 안 된다.
        # (자치구를 추가했는데 옛 캐시를 쓰면 철거비·일조가 통째로 누락된다)
        if not set(codes).issubset(cached):
            if verbose:
                print(f"  건물 캐시가 설정과 불일치 (캐시 {sorted(cached)} / "
                      f"설정 {sorted(codes)}) → 재생성")
            cache.unlink()
        else:
            if verbose:
                print(f"  건물 캐시 사용: {len(b):,}동  {sorted(cached)}")
            return b

    S = cfg["solar"]
    # 대상 자치구 + 인접 자치구까지 읽는다. 경계에 붙은 필지는 옆 구 건물이
    # 그림자를 만들기 때문이다. 읽은 뒤 경계 버퍼로 잘라낸다.
    codes = [d["code"] for d in cfg["region"]["districts"]]
    b = gpd.read_file(BUILDINGS_SHP, encoding=ENCODING)
    b = b[list(BUILDING_COLS) + ["geometry"]].rename(columns=BUILDING_COLS)
    for c in ["height_m", "floors_up"]:
        b[c] = pd.to_numeric(b[c], errors="coerce")
    b["footprint_sqm"] = b.geometry.area
    n = len(b)

    bad = b["height_m"].lt(0) | b["height_m"].gt(200)
    if bad.any():
        if verbose:
            print(f"  이상치 높이 {int(bad.sum())}건 → 결측 처리 "
                  f"(min {b.loc[bad, 'height_m'].min():.1f}m)")
        b.loc[bad, "height_m"] = np.nan

    fh = S["default_floor_height_m"]
    h = np.full(n, np.nan)
    src = np.full(n, "", dtype=object)

    m1 = b["height_m"].gt(0).to_numpy()
    h[m1], src[m1] = b.loc[m1, "height_m"], "실측"
    m2 = ~m1 & b["floors_up"].gt(0).to_numpy()
    h[m2], src[m2] = b.loc[m2, "floors_up"] * fh, "층수추정"
    m3 = ~m1 & ~m2

    U = S["unknown_building"]
    if U["method"] == "footprint_bin":
        edges = [x["max"] for x in U["footprint_bins"][:-1]]
        floors = np.array([x["floors"] for x in U["footprint_bins"]])
        idx = np.searchsorted(edges, b["footprint_sqm"].to_numpy(), side="left")
        h[m3], src[m3] = floors[idx][m3] * fh, "면적추정"
    elif U["method"] == "exclude":
        src[m3] = "제외"
    else:
        raise SystemExit(f"unknown_building.method 값이 잘못됨: {U['method']}")

    b["height_m"], b["height_src"] = h, src
    if verbose:
        print("  높이 출처별 (T-204)")
        for label in ["실측", "층수추정", "면적추정", "제외"]:
            k = int((src == label).sum())
            if k:
                hh = b.loc[src == label, "height_m"]
                extra = f"  중위 {hh.median():.1f}m" if hh.notna().any() else ""
                print(f"    {label:<8} {k:>7,}  {k / n:>5.1%}{extra}")

    b = b[b["height_m"].notna()].copy()
    # 철거 연면적 추정용 — 바닥면적 × 추정 층수
    b["est_gfa"] = b["footprint_sqm"] * np.maximum(b["height_m"] / fh, 1).round()

    # 대상 구 + 버퍼로 잘라낸다 (서울 전체를 들고 있을 이유가 없다)
    keep = region_mask(b, cfg, cfg["region"]["building_buffer_m"])
    if verbose:
        inn = b["sgg_cd"].isin(codes).sum()
        print(f"  대상 구 {inn:,}동 + 버퍼 {cfg['region']['building_buffer_m']}m "
              f"{int(keep.sum()) - inn:,}동")
    b = b[keep].copy()
    INTERIM.mkdir(parents=True, exist_ok=True)
    b.to_file(cache, driver="GPKG", layer="buildings")
    if verbose:
        print(f"  → 사용 건물 {len(b):,}동 (캐시 저장)")
    return b


def rent_index(g, cfg, verbose=True):
    """필지별 임대료 지역지수. 법정동 우선, 표본이 얇으면 자치구로 폴백 (D-024).

    PNU 앞 10자리 = 법정동코드 = API 의 CGG_CD + STDG_CD 다.
    """
    import json

    import numpy as np
    import pandas as pd

    if not cfg["profitability"].get("use_rent_index", False):
        if verbose:
            print("  지역지수 미사용 (use_rent_index: false) — 전 필지 동일 단가")
        return pd.Series(1.0, index=g.index), {}

    path = INTERIM / "rent_market.json"
    if not path.exists():
        raise SystemExit("rent_market.json 이 없습니다. scripts/09_rent_market.py 를 먼저 실행하세요")
    rm = json.loads(path.read_text(encoding="utf-8"))

    dong = {k.replace("|", ""): v["index"] for k, v in rm["by_dong"].items()}
    sgg = {k: v["index"] for k, v in rm["by_sgg"].items()}
    bjd = g["pnu"].str[:10]
    idx = bjd.map(dong)
    src = pd.Series("법정동", index=g.index)
    fallback = idx.isna()
    idx = idx.fillna(g["sgg_cd"].map(sgg))
    src[fallback] = "자치구"
    idx = idx.fillna(1.0)
    src[idx.isna()] = "기본"
    if verbose:
        print(f"  지역지수: 법정동 {int((src == '법정동').sum()):,} / "
              f"자치구 폴백 {int((src == '자치구').sum()):,}"
              f"   범위 {idx.min():.3f}~{idx.max():.3f} (중위 {idx.median():.3f})")
    return idx, rm
