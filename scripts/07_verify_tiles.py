"""타일 검증 — 웹이 조용히 틀린 답을 내는 것을 막는다.

타일과 meta.json 만으로 브라우저가 할 계산을 그대로 재현해서
Python 파이프라인 결과와 대조한다. T-502(JS 점수 엔진)의 대조 기준이기도 하다.

  1) 완전성   최대줌에 전 필지가 살아 있는가
  2) 왕복     타일 속성이 원본과 일치하는가
  3) 재계산   타일만으로 S₁·실수·후보판정·역세권등급을 복원할 수 있는가
  4) 순위     계층 정렬 상위 200이 집합·순서 모두 일치하는가

한 번이라도 실패하면 종료 코드 1. 06 을 다시 돌린 뒤에는 반드시 이걸 실행한다.
"""
import json
import subprocess
import sys

import geopandas as gpd
import numpy as np
import pandas as pd

from common import INTERIM, ROOT, load_config

WEB_DATA = ROOT / "web" / "data"
GRADE_ORDER = {"A": 0, "B": 1, "C": 2, "D": 3, "E": 4}
fails = []


def check(label, ok, detail=""):
    print(f"  {label:<26}{detail:>16}  {'✅' if ok else '❌'}")
    if not ok:
        fails.append(label)


def decode_max_zoom(cfg, meta):
    """타일은 그룹별 파일로 나뉘어 있다. 전부 디코드해 합친다."""
    z = str(cfg["tiles"]["max_zoom"])
    props = {}
    for grp in meta["tile_groups"]:
        pm = WEB_DATA / grp["file"]
        r = subprocess.run(
            ["tippecanoe-decode", "-z", z, "-Z", z, str(pm)],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            raise SystemExit(f"tippecanoe-decode 실패 ({grp['file']}):\n{r.stderr[-800:]}")
        _collect(r.stdout, props)
        print(f"  {grp['file']}  누적 {len(props):,}")
    return pd.DataFrame.from_dict(props, orient="index")


def _collect(stdout, props):
    for line in stdout.splitlines():
        line = line.strip().rstrip(",")
        if '"properties"' not in line:
            continue
        try:
            f = json.loads(line)
        except json.JSONDecodeError:
            continue
        p = f.get("properties", {})
        if "id" in p:
            props[p["id"]] = p


def main():
    cfg = load_config()
    meta = json.loads((WEB_DATA / "meta.json").read_text(encoding="utf-8"))
    D, FB, SC = meta["defaults"], meta["flag_bits"], meta["scale"]

    src = gpd.read_file(INTERIM / "parcels_ranked.gpkg", layer="parcels")
    src["id"] = src["pnu"]          # 타일 id 는 PNU 전체 (자치구 간 충돌 방지)
    src = src.set_index("id")

    print("═" * 62)
    print("타일 검증")
    t = decode_max_zoom(cfg, meta)

    print("\n1) 완전성")
    # 지켜야 할 불변식은 "적격 표(scoring.json)의 필지가 전부 타일에 있는가" 다.
    # 타일에는 없어도 되는 필지가 있다 — 면적 0~3㎡ 자투리는 z15 격자에서
    # 사라지는데, 후보가 될 수 없으므로 적격 표에서도 뺀다.
    elig = set(json.loads((WEB_DATA / "scoring.json").read_text(encoding="utf-8"))["ids"])
    have = set(t.index)
    check("적격 필지 100% 타일 존재", elig <= have,
          f"{len(elig & have):,}/{len(elig):,}")
    dropped = len(src) - len(t)
    check("타일 누락은 자투리뿐 (<0.05%)", dropped / len(src) < 0.0005,
          f"{dropped:,}/{len(src):,}")

    j = t.join(src, how="inner", rsuffix="_py")
    # 빈 조인은 모든 "불일치 0" 검사를 공허하게 통과시킨다. 먼저 조인부터 확인한다.
    check("타일↔원본 조인", len(j) >= len(src) - dropped, f"{len(j):,}/{len(src):,}")
    if not len(j):
        print("\n❌ 조인이 비었다. 타일 id 와 원본 id 형식을 확인할 것")
        sys.exit(1)

    print("\n2) 속성 왕복")
    for tk, sk, scale in [("a", "area_sqm", SC["a"]), ("f", "far_pct", 1),
                          ("t", "stn_dist_m", SC["t"]), ("d", "demo_gfa_sqm", SC["d"]),
                          ("x", "flags", 1), ("s", "sun", SC["s"]),
                          ("r", "realization", SC["r"]), ("p", "price_krw_sqm", SC["p"]),
                          ("ri", "rent_index", SC["ri"])]:
        exp = (j[sk].fillna(0) * scale).round(0).astype(float)
        bad = int((exp - j[tk].astype(float)).abs().gt(0.5).sum())
        check(f"{tk} ← {sk}", bad == 0, f"불일치 {bad:,}")

    print("\n3) 타일만으로 재계산 (브라우저가 할 계산)")
    area = j["a"].astype(float) / SC["a"]
    rf = j["r"].astype(float) / SC["r"]
    price = j["p"].astype(float) / SC["p"]
    demo = j["d"].astype(float) / SC["d"]
    dist = j["t"].astype(float) / SC["t"]
    ri = j["ri"].astype(float) / SC["ri"] if "ri" in j else 1.0   # 임대료 지역지수 (D-024)
    gfa = area * j["f"].astype(float) / 100 * rf
    rooms = np.floor(gfa * D["net_area_ratio"] / D["room_area_sqm"])
    cost = (price * area * D["land_price_multiplier"]
            + gfa * D["unit_construction_cost"] * (1 + D["soft_cost_ratio"])
            + demo * D["demolition_cost_per_sqm"])
    eq = cost - rooms * D["deposit_per_room"]
    noi = (rooms * D["monthly_rent_per_room"] * ri * 12
           * (1 - D["vacancy_rate"]) * (1 - D["opex_ratio"]))
    s1 = np.where(eq > 0, noi / np.where(eq > 0, eq, 1), np.nan)

    excl = (FB["F_JIMOK"] | FB["F_ZONE"] | FB["F_LANDUSE"]
            | FB["F_ROAD"] | FB["F_ROOMS"] | FB["F_PRICE"])
    cand = (j["x"].astype(int) & excl) == 0
    gr = D["grades"]
    grade = pd.cut(dist, [-np.inf, gr["A"], gr["B"], gr["C"], gr["D"], np.inf],
                   labels=list("ABCDE")).astype(str)

    # 임계값 1e-6 = 0.0001%p. 타일은 ×100 양자화라 잔차가 완전히 0일 수는 없다.
    # 정작 중요한 건 아래의 이산 결과(실 수·후보·등급)와 순위가 정확히 일치하는 것이고,
    # 이 크기의 잔차는 어떤 경계도 뒤집지 못한다. 실측 잔차는 2.3e-07 수준.
    err = float(np.nanmax(np.abs(s1 - j["s1_net_equity"])))
    check("S₁ 최대 절대오차", err < 1e-6, f"{err:.2e}")
    check("실 수", int((rooms != j["rooms"]).sum()) == 0,
          f"불일치 {int((rooms != j['rooms']).sum()):,}")
    check("후보 판정", int((cand != j["is_candidate"]).sum()) == 0,
          f"불일치 {int((cand != j['is_candidate']).sum()):,}")
    check("역세권 등급", int((grade != j["stn_grade"]).sum()) == 0,
          f"불일치 {int((grade != j['stn_grade']).sum()):,}")

    print("\n4) 계층 정렬 순위")
    c = pd.DataFrame({"s1": s1, "grade": grade, "cand": cand,
                      "sun": j["s"].astype(float) / SC["s"]}, index=j.index)
    c = c[c["cand"]]
    p1 = c["s1"].rank(pct=True) * 100
    p2 = c["sun"].rank(pct=True) * 100
    key = pd.DataFrame({
        "b1": np.floor((100 - p1) / D["tol_profitability_pct"]),
        "b2": np.floor((100 - p2) / D["tol_solar_pct"]),
        "g3": c["grade"].map(GRADE_ORDER),
        "s1": -c["s1"],
    }).sort_values(["b1", "b2", "g3", "s1"])
    top_tile = list(key.head(200).index)
    top_py = list(src[src["rank"].notna()].nsmallest(200, "rank").index)
    check("Python 상위200 확보", len(top_py) == 200, f"{len(top_py)}")
    same = len(set(top_tile) & set(top_py))
    order = sum(1 for a, b in zip(top_tile, top_py) if a == b)
    check("상위200 집합", same == 200, f"{same}/200")
    check("상위200 순서", order == 200, f"{order}/200")

    print("\n5) 산출물")
    for f in ([g["file"] for g in meta["tile_groups"]]
              + ["scoring.json", "adjacency.json", "stations.geojson",
                 "boundary.geojson", "meta.json"]):
        p = WEB_DATA / f
        check(f, p.exists(), f"{p.stat().st_size / 1e6:.1f}MB" if p.exists() else "없음")
    lim = cfg["tiles"]["max_size_mb"]
    biggest = max((WEB_DATA / g["file"]).stat().st_size for g in meta["tile_groups"]) / 1e6
    check("타일 파일당 상한", biggest <= lim, f"최대 {biggest:.1f}/{lim}MB")
    # git 은 파일당 100MB 를 넘기면 아예 받지 않는다. 상한보다 이쪽이 절대 기준이다.
    check("git 100MB 한도", biggest < 100, f"{biggest:.1f}MB")
    # 자치구가 빠지면 그 구는 지도에 아예 안 나온다
    covered = {c for g in meta["tile_groups"] for c in g["districts"]}
    want = {d["code"] for d in cfg["region"]["districts"]}
    check("타일 그룹이 전 자치구 포함", covered == want,
          f"{len(covered)}/{len(want)}")

    print("\n" + "═" * 62)
    if fails:
        print(f"❌ 실패 {len(fails)}건: {', '.join(fails)}")
        sys.exit(1)
    print("✅ 전 항목 통과 — 브라우저가 타일만으로 동일한 순위를 낼 수 있다")


if __name__ == "__main__":
    main()
