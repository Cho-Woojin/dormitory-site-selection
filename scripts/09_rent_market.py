"""Q-13 — 자치구·법정동별 임대료를 전월세 실거래로 산출.

지금까지는 임대료를 모든 필지에 같은 값으로 가정했다. 그런데 성동구 후보의
공시지가는 성북구의 1.85배다. 단가가 같으면 비싼 지역이 무조건 불리해지고,
자치구를 섞은 순위가 성립하지 않는다 (D-019).

  출처: 서울 열린데이터광장 `tbLnOpendataRentV` (전월세가 정보)
  필터: 대상 자치구 / 최근 N년 / 원룸급 면적 / 주거 용도

**전세·준전세는 전월세전환율로 월세 환산한다.** 보증금이 큰 계약을 그대로 두면
월세가 0에 가까워 시세를 왜곡한다.

임대형기숙사는 신축이라 실거래가 없다. 그래서 이 값은 **수준(level)이 아니라
지역 간 상대차(index)** 로만 쓴다. 수준은 코리빙 벤치마크가 정한다 (D-020).

출력: data/interim/rent_market.json
"""
import json
import os
import time

import numpy as np
import pandas as pd
import requests
from dotenv import load_dotenv

from common import INTERIM, ROOT, load_config

API = "http://openapi.seoul.go.kr:8088/{key}/json/tbLnOpendataRentV/{s}/{e}/{yr}/{cgg}"
PAGE = 1000

# 원룸·기숙사실에 대응하는 면적대. 아파트·대형은 시세 구조가 다르다.
AREA_MIN, AREA_MAX = 12.0, 40.0
# 임대형기숙사와 비교 가능한 용도만
USES = {"단독다가구", "연립다세대", "오피스텔"}
# 전월세전환율. 서울시 주택 기준 통상 5~6% (한국부동산원 공표치 범위)
CONVERSION_RATE = 0.055
YEARS = 3


def fetch(key, cgg, yr):
    rows, s = [], 1
    while True:
        url = API.format(key=key, s=s, e=s + PAGE - 1, yr=yr, cgg=cgg)
        r = requests.get(url, timeout=40)
        r.raise_for_status()
        body = r.json()[next(iter(r.json()))]
        code = body.get("RESULT", {}).get("CODE")
        if code == "INFO-200":          # 데이터 없음
            break
        if code != "INFO-000":
            raise SystemExit(f"API 오류 {cgg}/{yr}: {body.get('RESULT')}")
        got = body.get("row") or []
        rows += got
        total = body.get("list_total_count", 0)
        if s + PAGE - 1 >= total or not got:
            break
        s += PAGE
        time.sleep(0.15)
    return rows


def main():
    cfg = load_config()
    load_dotenv(ROOT / ".env")
    key = os.environ.get("SEOUL_OPENAPI_KEY")
    if not key:
        raise SystemExit(".env 에 SEOUL_OPENAPI_KEY 가 없습니다")

    districts = cfg["region"]["districts"]
    this_year = 2026
    years = [str(y) for y in range(this_year - YEARS + 1, this_year + 1)]

    print("═" * 64)
    print(f"Q-13 임대료 실거래 수집  ({', '.join(years)}년)")
    cache = INTERIM / "_rent_raw.json"
    if cache.exists():
        raw = json.loads(cache.read_text(encoding="utf-8"))
        print(f"  캐시 사용: {len(raw):,}건")
    else:
        raw = []
        for d in districts:
            for yr in years:
                got = fetch(key, d["code"], yr)
                print(f"  {d['name']} {yr}년  {len(got):>6,}건")
                raw += got
        cache.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        print(f"  합계 {len(raw):,}건 (캐시 저장)")

    df = pd.DataFrame(raw)
    for c in ["RENT_AREA", "GRFE", "RTFE"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.dropna(subset=["RENT_AREA", "GRFE"])

    print(f"\n필터")
    print(f"  전체                {len(df):>7,}")
    df = df[df["BLDG_USG"].isin(USES)]
    print(f"  주거용도 {'/'.join(USES)}  {len(df):>7,}")
    df = df[df["RENT_AREA"].between(AREA_MIN, AREA_MAX)]
    print(f"  면적 {AREA_MIN:.0f}~{AREA_MAX:.0f}㎡        {len(df):>7,}")

    # 전세·준전세 → 월세 환산. GRFE/RTFE 는 만원 단위.
    # 환산월세 = 월세 + 보증금 × 전환율 / 12
    df["eff_monthly"] = df["RTFE"].fillna(0) + df["GRFE"] * CONVERSION_RATE / 12
    df["per_sqm"] = df["eff_monthly"] / df["RENT_AREA"]      # 만원/㎡/월
    # 이상치 제거 (상하위 1%)
    lo, hi = df["per_sqm"].quantile([0.01, 0.99])
    df = df[df["per_sqm"].between(lo, hi)]
    print(f"  이상치 제거 후        {len(df):>7,}")
    print(f"\n  전월세전환율 {CONVERSION_RATE:.1%} 로 환산 "
          f"(전세 {int((df['RENT_SE'] == '전세').sum()):,} / 월세 {int((df['RENT_SE'] == '월세').sum()):,})")

    # ── 자치구 ─────────────────────────────────────────────
    by_sgg = df.groupby("CGG_CD")["per_sqm"].agg(["size", "median"])
    by_sgg.columns = ["n", "per_sqm"]
    base_code = districts[0]["code"]
    base = float(by_sgg.loc[base_code, "per_sqm"])
    by_sgg["index"] = by_sgg["per_sqm"] / base

    print(f"\n=== 자치구별 (기준: {districts[0]['name']} = 1.00) ===")
    name = {d["code"]: d["name"] for d in districts}
    for code, r in by_sgg.iterrows():
        print(f"  {name.get(code, code):<6} 표본 {int(r['n']):>6,}  "
              f"{r['per_sqm']:.2f}만원/㎡  지수 {r['index']:.3f}")

    # ── 법정동 (표본 30건 이상만) ───────────────────────────
    by_dong = df.groupby(["CGG_CD", "STDG_CD", "STDG_NM"])["per_sqm"].agg(["size", "median"])
    by_dong.columns = ["n", "per_sqm"]
    solid = by_dong[by_dong["n"] >= 30].copy()
    solid["index"] = solid["per_sqm"] / base
    print(f"\n=== 법정동별 (표본 30건 이상: {len(solid)}개 / 전체 {len(by_dong)}개) ===")
    top = solid.sort_values("index", ascending=False)
    for (cd, sd, nm), r in list(top.head(6).iterrows()) + [("…",) * 3 and (("", "", "…"), None)][:0]:
        print(f"  {name.get(cd, cd):<5} {nm:<10} 표본 {int(r['n']):>5,}  "
              f"{r['per_sqm']:.2f}만원/㎡  지수 {r['index']:.3f}")
    print("  …")
    for (cd, sd, nm), r in top.tail(4).iterrows():
        print(f"  {name.get(cd, cd):<5} {nm:<10} 표본 {int(r['n']):>5,}  "
              f"{r['per_sqm']:.2f}만원/㎡  지수 {r['index']:.3f}")

    out = {
        "source": "서울 열린데이터광장 tbLnOpendataRentV",
        "years": years,
        "filter": {"uses": sorted(USES), "area_min": AREA_MIN, "area_max": AREA_MAX,
                   "conversion_rate": CONVERSION_RATE},
        "n_transactions": int(len(df)),
        "base_district": base_code,
        "base_per_sqm_manwon": round(base, 4),
        "by_sgg": {str(c): {"n": int(r["n"]), "per_sqm": round(r["per_sqm"], 4),
                            "index": round(r["index"], 4)}
                   for c, r in by_sgg.iterrows()},
        "by_dong": {f"{cd}|{sd}": {"name": nm, "n": int(r["n"]),
                                   "per_sqm": round(r["per_sqm"], 4),
                                   "index": round(r["index"], 4)}
                    for (cd, sd, nm), r in solid.iterrows()},
    }
    path = INTERIM / "rent_market.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n✅ 저장: {path}  (자치구 {len(by_sgg)} / 법정동 {len(solid)})")
    print("\n  이 값은 **지역 간 상대차(index)** 로만 쓴다.")
    print("  수준은 코리빙 벤치마크(D-020)가 정한다. 일반 원룸과 코리빙은 가격대가 다르다.")


if __name__ == "__main__":
    main()
