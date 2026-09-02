/* 링크 미리보기용 썸네일 (1200×630) 생성.
 *
 * 카카오톡·슬랙 등은 og:image 를 읽는다. 지도 화면을 그대로 쓰면 패널이
 * 절반을 가리므로, 패널을 감춘 지도를 배경으로 깔고 제목을 얹는다.
 *
 * 사용: node tools/social_card.mjs [baseUrl] [출력경로]
 */
import { chromium } from "playwright-core";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

const BASE = process.argv[2] || "http://127.0.0.1:8899/";
const OUT = process.argv[3] || "web/og-card.jpg";
const TMP = "/tmp/_og_map.png";

const browser = await chromium.launch({
  channel: "chrome", headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--hide-scrollbars"],
});

// 1) 패널 없는 지도만 캡처
const pg = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 });
await pg.goto(BASE, { waitUntil: "domcontentloaded" });
await pg.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
await pg.waitForFunction(() => window.__map?.loaded?.(), null, { timeout: 120000 });
const meta = await pg.evaluate(async () => {
  for (const id of ["params", "list", "legend", "hub", "asm", "detail"]) {
    const e = document.getElementById(id);
    if (e) e.style.display = "none";
  }
  document.querySelector("header").style.display = "none";
  for (const c of document.querySelectorAll(".maplibregl-ctrl")) c.style.display = "none";
  document.getElementById("map").style.inset = "0";
  window.__map.resize();
  // 서울 덩어리를 오른쪽 절반에 오게 한다 (왼쪽은 제목이 덮는다)
  window.__map.jumpTo({ center: [126.9200, 37.5540], zoom: 10.9 });
  await new Promise((r) => setTimeout(r, 9000));
  const m = window.__state.meta;
  return {
    nd: m.districts.length,
    parcels: m.parcel_count,
    cand: window.__state.result.order.length,
  };
});
await pg.waitForTimeout(2000);
await pg.screenshot({ path: TMP });
await pg.close();

// 2) 지도 위에 제목을 얹은 카드
const b64 = readFileSync(TMP).toString("base64");
const card = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1.5 });
await card.setContent(`
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
<style>
  * { margin:0; padding:0; box-sizing:border-box }
  body { width:1200px; height:630px; position:relative; overflow:hidden;
         font-family:Pretendard,-apple-system,sans-serif; color:#0b0b0b; background:#fcfcfb }
  .map { position:absolute; inset:0; background:url(data:image/png;base64,${b64}) center/cover }
  .veil { position:absolute; inset:0;
          background:linear-gradient(100deg, #fcfcfbFA 0%, #fcfcfbF2 38%, #fcfcfb99 54%, #fcfcfb1A 72%, #fcfcfb00 100%) }
  .box { position:absolute; left:64px; top:0; height:100%; width:660px;
         display:flex; flex-direction:column; justify-content:center; gap:18px }
  h1 { font-size:52px; font-weight:800; letter-spacing:-1.6px; line-height:1.14 }
  .sub { font-size:24px; font-weight:500; color:#52514e; line-height:1.45 }
  .stats { display:flex; gap:34px; margin-top:6px }
  .stat .n { font-size:34px; font-weight:750; letter-spacing:-0.8px;
             font-variant-numeric:tabular-nums; color:#1c5cab }
  .stat .l { font-size:15px; color:#7c7b76; margin-top:2px }
  .tag { position:absolute; left:64px; bottom:46px; font-size:16px; color:#7c7b76 }
</style>
<div class="map"></div><div class="veil"></div>
<div class="box">
  <h1>임대형기숙사<br>적합 필지 탐색</h1>
  <div class="sub">개별공시지가 대비 사업성 · 일조환경 · 역세권을<br>오차범위 계층 정렬로 평가합니다</div>
  <div class="stats">
    <div class="stat"><div class="n">${meta.parcels.toLocaleString()}</div><div class="l">서울 ${meta.nd}개 자치구 필지</div></div>
    <div class="stat"><div class="n">${meta.cand.toLocaleString()}</div><div class="l">후보 필지</div></div>
  </div>
</div>
<div class="tag">파라미터를 직접 조정하며 탐색하는 웹 지도</div>
`, { waitUntil: "networkidle" });
await card.waitForTimeout(1200);
await card.screenshot({ path: OUT, type: "jpeg", quality: 88 });
await card.close();
await browser.close();
try { unlinkSync(TMP); } catch {}
console.log(`${OUT} · 서울 ${meta.nd}개 구 · 필지 ${meta.parcels.toLocaleString()} · 후보 ${meta.cand.toLocaleString()}`);
