"""검증 기준 파일 생성 — Python 결과를 브라우저와 대조하기 위한 정답지.

`tools/verify_ui.mjs` 가 읽는다. 지금까지 이 파일들은 손으로 만들어져 있어서
파이프라인을 다시 돌려도 갱신되지 않았다. 정답지가 데이터보다 오래되면
검증은 통과하면서도 아무것도 지키지 못한다.

출력:
  _py_top200.txt    계층 정렬 상위 200 PNU (순서 포함)
  _py_assembly.json 합필 기준 세트 10건 — 연접 그룹의 정확한 수치
  _py_price.json    개별공시지가 표시 대조용 (단가·총액·공시일자)

사용: python3 scripts/10_verify_refs.py
"""
import json

import geopandas as gpd
import numpy as np

from common import (F_JIMOK, F_LANDUSE, F_PRICE, F_ROAD, F_ZONE,
                    INTERIM, load_config)

N_TOP = 200
N_ASM = 10
N_PRICE = 12


def build_assembly_refs(g, cfg):
    """연접 그룹을 골라 합필 후 수치를 낸다. 08_assembly 와 같은 식을 쓴다."""
    import importlib
    merged_metrics = importlib.import_module("08_assembly").merged_metrics

    # 웹의 scoring.json 과 **같은 정적 필터**를 써야 한다. 여기가 어긋나면
    # 기준 세트에 웹이 모르는 필지가 섞여 대조 자체가 성립하지 않는다.
    static = F_JIMOK | F_ZONE | F_LANDUSE | F_ROAD | F_PRICE
    pool = g[(g["flags"] & static) == 0].reset_index(drop=True)

    sj = gpd.sjoin(pool[["geometry"]], pool[["geometry"]],
                   predicate="touches", how="inner")
    adj = {}
    for a, b in zip(sj.index, sj["index_right"]):
        a, b = int(a), int(b)
        if a != b:
            adj.setdefault(a, set()).add(b)

    # 씨앗은 실제 사업 규모대(300~3,000㎡)에서 고른다. 무작정 큰 필지를 쓰면
    # 10만㎡짜리 묶음이 나오는데, 그건 한 화면에 안 들어와 도형을 못 읽을 뿐
    # 실제 합필 시나리오도 아니다. 검증은 제품을 재야지 하네스를 재면 안 된다.
    seeds = pool[pool["area_sqm"].between(300, 3000)].nlargest(600, "area_sqm").index
    out = []
    for seed in seeds:
        grp = [int(seed)]
        while len(grp) < 5:
            cand = {j for i in grp for j in adj.get(i, ())} - set(grp)
            if not cand:
                break
            grp.append(min(cand))
        if len(grp) < 3:
            continue
        m = merged_metrics(pool.loc[grp], cfg)
        if not np.isfinite(m["s1"]) or m["rooms"] < cfg["filters"]["min_rooms"]:
            continue
        if m["area"] > 30000:          # 한 화면에 안 들어오면 대조가 불가능하다
            continue
        rep = pool.loc[grp[0], "geometry"].representative_point()
        ll = gpd.GeoSeries([rep], crs=pool.crs).to_crs("EPSG:4326").iloc[0]
        # 묶음 전체를 화면에 넣으려면 범위가 필요하다. 고정 줌으로는
        # 큰 묶음이 잘려 도형을 못 읽는다.
        bb = gpd.GeoSeries([m["geom"]], crs=pool.crs).to_crs("EPSG:4326").total_bounds
        out.append({
            "pnus": list(pool.loc[grp, "pnu"]),
            "area": round(m["area"], 1), "rf": round(m["rf"], 6),
            "gfa": round(m["gfa"], 2), "rooms": int(m["rooms"]),
            "s1": round(float(m["s1"]), 8), "cost": round(m["cost"], 0),
            "lon": round(ll.x, 5), "lat": round(ll.y, 6),
            "bbox": [round(float(v), 6) for v in bb],
        })
        if len(out) >= N_ASM:
            break
    return out


def main():
    cfg = load_config()
    g = gpd.read_file(INTERIM / "parcels_ranked.gpkg", layer="parcels")
    print("═" * 62)
    print("검증 기준 파일 생성")

    # ── 상위 200 ────────────────────────────────────────────────────
    top = g[g["rank"].notna()].nsmallest(N_TOP, "rank")
    (INTERIM / "_py_top200.txt").write_text(
        "\n".join(top["pnu"]) + "\n", encoding="utf-8")
    print(f"  _py_top200.txt    {len(top)}건")

    # ── 개별공시지가 ────────────────────────────────────────────────
    # 공시일자별로 고르게 뽑는다. 한 날짜만 검사하면 날짜가 어긋나도 못 잡는다.
    # 표본은 **웹이 아는 필지**(정적 필터 통과분)에서 골라야 한다. 전체에서
    # 고르면 대부분 웹 인덱스에 없어 검사가 조용히 통과한다.
    static = F_JIMOK | F_ZONE | F_LANDUSE | F_ROAD | F_PRICE
    have = g[((g["flags"] & static) == 0) & g["price_krw_sqm"].gt(0)]
    rows = []
    for date, sub in have.groupby("price_ref_date"):
        for _, r in sub.nlargest(N_PRICE // max(have["price_ref_date"].nunique(), 1),
                                 "area_sqm").iterrows():
            rows.append({
                "pnu": r["pnu"],
                "name": r["addr"].replace("서울특별시 ", "") + " " + r["jibun"],
                "price": int(r["price_krw_sqm"]),
                "area": float(r["area_sqm"]),
                "total": float(r["price_krw_sqm"] * r["area_sqm"]),
                "date": str(date),
                "source": r["price_source"],
            })
    missing = g[g["price_krw_sqm"].fillna(0).le(0)]
    ref = {"rows": rows,
           "missing_pnu": list(missing["pnu"][:3]),
           "missing_count": int(len(missing)),
           "dates": {str(k): int(v) for k, v in
                     have["price_ref_date"].value_counts().items()}}
    (INTERIM / "_py_price.json").write_text(
        json.dumps(ref, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"  _py_price.json    {len(rows)}건  공시일자 {ref['dates']}  "
          f"자료없음 {ref['missing_count']}")

    # ── 합필 ────────────────────────────────────────────────────────
    asm = build_assembly_refs(g, cfg)
    (INTERIM / "_py_assembly.json").write_text(
        json.dumps(asm, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"  _py_assembly.json {len(asm)}건  "
          f"규모 {min(a['rooms'] for a in asm)}~{max(a['rooms'] for a in asm)}실")

    print("\n✅ tools/verify_ui.mjs 가 이 파일들을 정답지로 쓴다")


if __name__ == "__main__":
    main()
