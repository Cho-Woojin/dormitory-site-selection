"""합필(인접 필지 통합) 시뮬레이션.

단일 필지로는 규모가 안 나오는 땅도 인접 필지를 묶으면 후보가 된다.
반대로 합필에는 숨은 비용이 있다:

  - 준공업지역은 부지 **3,000㎡ 이상**이면 공동주택 지구단위계획 수립 의무가 생긴다
    (서울시 도시계획조례 2025-03-27 개정). 수년이 걸리는 절차다.
  - 합필은 **연접**이 요건이다. 도로·하천으로 갈린 필지는 합필할 수 없다.
    길 건너 필지는 '2동 체제'(별개 건축물, 하나의 운영)로만 가능하다.
  - 필지가 많을수록 매입 협상 실패 위험이 곱해진다.

실현계수는 합필 폴리곤의 **실제 형상**에서 다시 구한다. 개별 필지 형상 계수를
그대로 평균내면 합필의 정형화 효과를 놓친다.

사용: python3 08_assembly.py [자치구명] [최대묶음수]
"""
import sys

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.ops import unary_union

from common import INTERIM, load_config

# 준공업지역 공동주택 지구단위계획 의무 기준 (서울시 조례 2025-03-27)
DISTRICT_PLAN_THRESHOLD_SQM = 3000
INDUSTRIAL_ZONES = {"준공업지역", "전용공업지역", "일반공업지역"}


def shape_factor_from_geom(geom):
    """합필 폴리곤의 정형성 → 형상계수.

    면적 / 최소회전외접사각형 면적. 1.0 이면 완전 직사각형.
    params.yaml 의 형상 등급(정방형 1.00 ~ 자루형 0.75)과 같은 범위로 맞춘다.
    """
    mrr = geom.minimum_rotated_rectangle
    ratio = geom.area / mrr.area if mrr.area > 0 else 0.0
    # 실측 등급 대응: 정방형/장방형 ~0.95 이상, 사다리형 ~0.85, 부정형 ~0.7 이하
    return float(np.clip(0.70 + 0.32 * ratio, 0.70, 1.00))


def merged_metrics(rows, cfg):
    """필지 묶음 하나의 합필 후 지표."""
    P = cfg["profitability"]
    geom = unary_union(list(rows.geometry))
    area = float(rows["area_sqm"].sum())

    # 용적률은 면적가중 (한 묶음에 두 용도지역이 섞일 수 있다)
    far = float((rows["far_pct"] * rows["area_sqm"]).sum() / area)
    # 실현계수는 합필 폴리곤의 실제 형상에서 다시 구한다
    terr = rows.loc[rows["area_sqm"].idxmax(), "terrain"]
    terr_f = P["realization"]["slope_factor"].get(terr, 0.95)
    rf = P["realization"]["base"] * shape_factor_from_geom(geom) * terr_f

    gfa = area * far / 100 * rf
    rooms = np.floor(gfa * P["net_area_ratio"] / P["room_area_sqm"])
    land = float((rows["price_krw_sqm"] * rows["area_sqm"]).sum()) * P["land_price_multiplier"]
    build = gfa * P["unit_construction_cost"] * (1 + P["soft_cost_ratio"])
    demo = float(rows["demo_gfa_sqm"].sum()) * P["demolition_cost_per_sqm"]
    total = land + build + demo
    eq = total - rooms * P["deposit_per_room"]
    noi = (rooms * P["monthly_rent_per_room"] * 12
           * (1 - P["vacancy_rate"]) * (1 - P["opex_ratio"]))
    return {
        "n": len(rows), "area": area, "far": far, "rf": rf,
        "gfa": gfa, "rooms": int(rooms), "cost": total,
        "s1": noi / eq if eq > 0 else np.nan,
        "sun": float(rows["sun"].mean()),
        "stn": float(rows["stn_dist_m"].min()),
        "zone": rows.loc[rows["area_sqm"].idxmax(), "zone1"],
        "geom": geom,
    }


def main():
    cfg = load_config()
    target = sys.argv[1] if len(sys.argv) > 1 else "성동구"
    max_n = int(sys.argv[2]) if len(sys.argv) > 2 else 5

    g = gpd.read_file(INTERIM / "parcels_ranked.gpkg", layer="parcels")
    # 합필은 지목이 같아야 한다. 후보는 이미 '대' 뿐이지만, 후보 아닌 인접 필지도
    # 합필 대상이 될 수 있다 (규모 미달로 탈락한 작은 필지가 핵심이다).
    pool = g[(g["sgg_nm"] == target) & (g["jimok"] == "대")
             & g["housing_ok"] & g["price_krw_sqm"].gt(0)].copy()
    pool = pool[~pool["landuse"].isin(cfg["filters"]["excluded_landuse"])]
    pool = pool[~pool["road_side"].isin(cfg["filters"]["excluded_road_access"])]
    pool = pool.reset_index(drop=True)

    print("═" * 66)
    print(f"합필 시뮬레이션 · {target}")
    print(f"  합필 후보 풀: {len(pool):,} 필지 (규모 미달 포함)")
    print(f"    단독 후보  : {int(pool['is_candidate'].sum()):,}")
    print(f"    규모 미달  : {int((~pool['is_candidate']).sum()):,}  ← 합필로 살아날 수 있는 땅")

    # 인접 그래프 (연접 = 경계가 닿음). 도로로 갈린 필지는 여기서 자동으로 빠진다.
    print("\n  인접 관계 계산 중…")
    sj = gpd.sjoin(pool[["geometry"]], pool[["geometry"]],
                   predicate="touches", how="inner")
    pairs = [(a, b) for a, b in zip(sj.index, sj["index_right"]) if a < b]
    print(f"  연접 쌍 {len(pairs):,}")

    # 연결 요소
    parent = list(range(len(pool)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in pairs:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    comp = {}
    for i in range(len(pool)):
        comp.setdefault(find(i), []).append(i)
    blocks = [v for v in comp.values() if 2 <= len(v) <= 40]
    print(f"  연결 블록 {len(blocks):,}개 (2~40필지)")

    # 각 블록에서 최대 max_n 개를 탐욕적으로 묶는다.
    # 기준: 합필 후 수익률. 블록 전체를 쓰면 매입 난도가 비현실적으로 커진다.
    print(f"\n  블록별 최적 묶음 탐색 (최대 {max_n}필지)…")
    out = []
    for idxs in blocks:
        sub = pool.loc[idxs]
        adj = {i: set() for i in idxs}
        s = set(idxs)
        for a, b in pairs:
            if a in s and b in s:
                adj[a].add(b)
                adj[b].add(a)
        # 시드는 블록 내 면적 상위 3개만 (탐색 폭 제한)
        for seed in sub.nlargest(min(3, len(sub)), "area_sqm").index:
            cur = [seed]
            best = merged_metrics(pool.loc[cur], cfg)
            while len(cur) < max_n:
                cand = {j for i in cur for j in adj[i]} - set(cur)
                if not cand:
                    break
                scored = [(merged_metrics(pool.loc[cur + [j]], cfg), j) for j in cand]
                m, j = max(scored, key=lambda t: (t[0]["rooms"] >= cfg["filters"]["min_rooms"],
                                                  t[0]["s1"] if np.isfinite(t[0]["s1"]) else -1))
                if not np.isfinite(m["s1"]):
                    break
                # 실 수가 늘지 않는 합필은 의미가 없다
                if m["rooms"] <= best["rooms"]:
                    break
                cur.append(j)
                best = m
            if best["n"] >= 2 and best["rooms"] >= cfg["filters"]["min_rooms"]:
                best["pnus"] = list(pool.loc[cur, "pnu"])
                best["addr"] = pool.loc[cur[0], "addr"].replace(f"서울특별시 {target} ", "")
                best["jibuns"] = ", ".join(pool.loc[cur, "jibun"])
                best["solo_max"] = float(pool.loc[cur, "s1_net_equity"].max())
                best["solo_cand"] = int(pool.loc[cur, "is_candidate"].sum())
                out.append(best)

    if not out:
        print("  조건을 만족하는 합필 묶음이 없습니다.")
        return

    df = pd.DataFrame(out).drop(columns=["geom"])
    df = df.sort_values("s1", ascending=False).drop_duplicates("addr").head(15)
    df["지구단위"] = np.where(
        df["area"] >= DISTRICT_PLAN_THRESHOLD_SQM,
        np.where(df["zone"].isin(INDUSTRIAL_ZONES), "필요", "-"), "-")

    print(f"\n  합필 묶음 {len(out):,}건 중 수익률 상위 15\n")
    view = pd.DataFrame({
        "동": df["addr"].str.split().str[-1],
        "지번": df["jibuns"].str.slice(0, 26),
        "필지": df["n"],
        "면적": df["area"].round(0).astype(int),
        "용도지역": df["zone"].str.replace("지역", "", regex=False),
        "실현계수": df["rf"].round(2),
        "실수": df["rooms"],
        "S1%": (df["s1"] * 100).round(2),
        "단독최고S1%": (df["solo_max"] * 100).round(2),
        "단독후보": df["solo_cand"],
        "사업비억": (df["cost"] / 1e8).round(0).astype(int),
        "지구단위": df["지구단위"],
    })
    print(view.to_string(index=False))

    big = (df["area"] >= DISTRICT_PLAN_THRESHOLD_SQM) & df["zone"].isin(INDUSTRIAL_ZONES)
    print(f"\n  ⚠️ 준공업 3,000㎡ 초과로 지구단위계획이 필요해지는 묶음: {int(big.sum())}/{len(df)}")
    gain = df["s1"] - df["solo_max"]
    print(f"  합필 이득 (합필 S1 − 구성필지 단독 최고 S1): 중위 {gain.median() * 100:+.2f}%p")
    print(f"  단독으로는 후보가 하나도 없던 묶음: {int((df['solo_cand'] == 0).sum())}/{len(df)}")


if __name__ == "__main__":
    main()
