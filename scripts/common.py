"""공통 설정·경로·컬럼 매핑.

컬럼명은 브이월드 "국가중점데이터 컬럼정의서" 원문을 따른다.
추측하지 말 것 — data/raw/land_characteristics/컬럼정의서.xlsx 참조.
"""
from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
INTERIM = ROOT / "data" / "interim"

PARCELS_SHP = RAW / "land_characteristics" / "11290" / "AL_D194_11290_20260520.shp"
BUILDINGS_SHP = RAW / "GIS건물통합정보_서울" / "AL_D010_11_20260809.shp"
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

FILTER_LABELS = [
    (F_JIMOK, "F6 지목≠대"),
    (F_ZONE, "F1 용도지역 불가"),
    (F_LANDUSE, "F3 토지이용상황"),
    (F_ROAD, "F4 접도 불가"),
    (F_PRICE, "   공시지가 결측"),
    (F_ROOMS, "F5 20실 미만"),
]


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
    if cache.exists():
        b = gpd.read_file(cache, layer="buildings")
        if verbose:
            print(f"  건물 캐시 사용: {len(b):,}동")
        return b

    S = cfg["solar"]
    b = gpd.read_file(
        BUILDINGS_SHP, encoding=ENCODING, where=f"A23 = '{cfg['region']['sgg_code']}'"
    )
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
    INTERIM.mkdir(parents=True, exist_ok=True)
    b.to_file(cache, driver="GPKG", layer="buildings")
    if verbose:
        print(f"  → 사용 건물 {len(b):,}동 (캐시 저장)")
    return b
