"""T-305 — 오차범위 계층 정렬 (METHODOLOGY §0).

    band₁  = floor( (100 − pctile(S₁)) / tol₁ )
    band₂  = floor( (100 − pctile(S₂)) / tol₂ )
    grade₃ = 역세권 등급 A~E
    정렬키 = (band₁ ↑, band₂ ↑, grade₃ ↑, S₁ ↓)

이 로직은 브라우저(JS)에서도 동일하게 재구현되므로 (T-502),
여기서의 결과가 대조 기준이 된다.

출력: data/interim/parcels_ranked.gpkg
"""
import geopandas as gpd
import numpy as np
import pandas as pd

from common import INTERIM, load_config

GRADE_ORDER = {"A": 0, "B": 1, "C": 2, "D": 3, "E": 4}


def rank_lexicographic(c, tol1, tol2):
    """오차범위 밴드 계층 정렬 → 순위(1부터) Series 반환."""
    p1 = c["s1_net_equity"].rank(pct=True) * 100
    p2 = c["sun"].rank(pct=True) * 100
    # tol=0 이면 밴딩하지 않는다 (해당 지표 단독 정렬)
    b1 = -p1 if tol1 == 0 else np.floor((100 - p1) / tol1)
    b2 = -p2 if tol2 == 0 else np.floor((100 - p2) / tol2)
    key = pd.DataFrame({
        "b1": b1,
        "b2": b2,
        "g3": c["stn_grade"].map(GRADE_ORDER),
        "s1": -c["s1_net_equity"],
    })
    order = key.sort_values(["b1", "b2", "g3", "s1"]).index
    return pd.Series(np.arange(1, len(order) + 1), index=order)


def main():
    cfg = load_config()
    R = cfg["ranking"]
    tol1, tol2 = R["tol_profitability_pct"], R["tol_solar_pct"]

    g = gpd.read_file(INTERIM / "parcels_s2.gpkg", layer="parcels")
    c = g[g["is_candidate"]].copy()
    print("═" * 62)
    print(f"T-305  계층 정렬   후보 {len(c):,} 필지   tol₁={tol1} tol₂={tol2}")

    # ── 회귀 테스트: tol₁=0 이면 순위가 S₁ 순서를 그대로 따라야 한다 ──
    # 주의: 순위 배열을 rank(method="first") 와 직접 비교하면 안 된다.
    # S₁ 동점 필지(282건)를 계층 정렬은 S₂로 타이브레이크하는데, 이는 방법론상
    # 올바른 동작이다. 검증해야 할 불변식은 "rank 순서대로 S₁이 비증가" 이다.
    r0 = rank_lexicographic(c, 0, 0).reindex(c.index)
    s1_sorted = c.assign(_r=r0).sort_values("_r")["s1_net_equity"]
    viol = int((s1_sorted.diff().dropna() > 1e-12).sum())
    ties = int(c["s1_net_equity"].duplicated(keep=False).sum())
    print(f"\n  회귀: tol₁=0 → S₁ 단조 비증가 위반 {viol}건"
          f"  (S₁ 동점 {ties:,}건은 S₂로 타이브레이크)  {'✅' if viol == 0 else '❌'}")
    assert viol == 0, "tol=0 인데 순위가 S₁ 순서를 어김 — 정렬 로직 버그"

    # ── tolerance 민감도 ────────────────────────────────────────────────
    base = set(r0.nsmallest(200).index)
    print(f"\n  tol₁ 민감도 (상위 200 중 S₁ 단독 순위와 겹치는 수)")
    for t in [0, 1, 2, 5, 10, 20]:
        top = set(rank_lexicographic(c, t, tol2).nsmallest(200).index)
        mark = "  ← 기본값" if t == tol1 else ""
        print(f"    tol₁={t:>3}  {len(top & base):>3}/200{mark}")

    # ── 본 정렬 ─────────────────────────────────────────────────────────
    c["rank"] = rank_lexicographic(c, tol1, tol2)
    g["rank"] = c["rank"]
    g["rank_pct"] = c["rank"] / len(c)

    top = c.nsmallest(200, "rank")
    print(f"\n  상위 200 구성")
    print(f"    자치구  : {dict(top['sgg_nm'].value_counts())}")
    print(f"    역세권등급: {dict(top['stn_grade'].value_counts().sort_index())}")
    print(f"    용도지역  : {dict(top['zone1'].value_counts())}")
    print(f"    S₁ 중위 {top['s1_net_equity'].median():.2%} | "
          f"S₂ 중위 {top['sun'].median():.3f} | 역거리 중위 {top['stn_dist_m'].median():.0f}m")
    print(f"    (전체 후보: S₁ {c['s1_net_equity'].median():.2%} | "
          f"S₂ {c['sun'].median():.3f} | 역거리 {c['stn_dist_m'].median():.0f}m)")

    print(f"\n  상위 15 필지")
    t = top.nsmallest(15, "rank")
    view = pd.DataFrame({
        "순위": t["rank"].astype(int),
        "소재지": t["addr"].str.replace("서울특별시 ", "", regex=False) + " " + t["jibun"],
        "용도지역": t["zone1"].str.replace("지역", "", regex=False),
        "면적": t["area_sqm"].round(0).astype(int),
        "실수": t["rooms"].astype(int),
        "S1": (t["s1_net_equity"] * 100).round(2),
        "S2": t["sun"].round(3),
        "역": t["stn_grade"],
        "역m": t["stn_dist_m"].round(0).astype(int),
        "사업비억": (t["cost_total"] / 1e8).round(0).astype(int),
    })
    print(view.to_string(index=False))

    out = INTERIM / "parcels_ranked.gpkg"
    g.to_file(out, driver="GPKG", layer="parcels")
    print(f"\n✅ 저장: {out}")


if __name__ == "__main__":
    main()
