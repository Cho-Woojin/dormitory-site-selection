/* README 용 스크린샷 캡처 (정릉동 중심).
 *
 * 사용: node tools/capture.mjs [baseUrl] [outDir]
 * 서버가 떠 있어야 한다:  python3 tools/serve.py 8899 web
 *
 * PNG 로 저장되므로 커밋 전에 WebP 로 줄인다 (19MB -> 2MB):
 *   cd docs/images
 *   for f in *.png; do sips -Z 1600 "$f" --out "/tmp/$f" >/dev/null
 *     cwebp -quiet -q 84 -m 6 "/tmp/$f" -o "${f%.png}.webp"; done && rm -f *.png
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = process.argv[2] || "http://127.0.0.1:8899/";
const OUT = process.argv[3] || "docs/images";
mkdirSync(OUT, { recursive: true });

const GU = [127.0175, 37.6065];       // 성북구 전체
const JR = [127.00564, 37.61223];     // 정릉동 상위 후보 밀집부
const JR_S = [127.01050, 37.60000];   // 정릉동 남부 (607/548 일대)

const browser = await chromium.launch({
  channel: "chrome", headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--hide-scrollbars"],
});

async function shot(name, opts = {}) {
  const {
    w = 1600, h = 950, theme = "light", center = JR, zoom = 15.4,
    setup = null, settle = 6000,
  } = opts;
  const pg = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1.5 });
  await pg.goto(BASE, { waitUntil: "domcontentloaded" });
  await pg.waitForFunction(() => document.getElementById("boot")?.hidden === true, null, { timeout: 60000 });
  await pg.waitForFunction(() => window.__map?.loaded?.(), null, { timeout: 60000 });
  await pg.evaluate((t) => {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem("dss-theme", t); } catch {}
    const m = window.__map;
    if (m?.getLayer("osm")) {
      const dark = t === "dark";
      m.setPaintProperty("osm", "raster-opacity", dark ? 0.38 : 0.55);
      m.setPaintProperty("osm", "raster-saturation", dark ? -0.7 : -0.55);
      m.setPaintProperty("osm", "raster-brightness-max", dark ? 0.72 : 1);
    }
  }, theme);
  // jumpTo 는 Map 객체를 반환한다. 그대로 두면 Playwright 가 직렬화하려다 멈춘다.
  await pg.evaluate(([c, z]) => { window.__map.jumpTo({ center: c, zoom: z }); }, [center, zoom]);
  await pg.waitForTimeout(settle);
  if (setup) await setup(pg);
  await pg.screenshot({ path: `${OUT}/${name}.png` });
  await pg.close();
  console.log(`  ${OUT}/${name}.png`);
}

const setRange = async (pg, id, v) => {
  await pg.evaluate(([i, val]) => {
    const el = document.getElementById(i);
    el.value = String(val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, [id, v]);
  await pg.waitForTimeout(700);
};
const pickJeongneung = async (pg, jibun) => {
  await pg.evaluate((jb) => {
    const s = window.__state;
    const i = s.D.names.findIndex((n) => n === `정릉동 ${jb}`);
    if (i >= 0) {
      const id = s.D.ids[i];
      const rows = [...document.querySelectorAll("#listBody .row")];
      const hit = rows.find((r) => r.dataset.id === id);
      if (hit) hit.click();
    }
  }, jibun);
  await pg.waitForTimeout(2600);
};

console.log("캡처 시작 (정릉동)");
// 01 성북구 전경
await shot("01-overview-seongbuk", { center: GU, zoom: 12.5 });
// 02 정릉동 일대
await shot("02-jeongneung-area", { center: JR, zoom: 14.4 });
// 03 정릉동 확대 - 적합도 분포
await shot("03-jeongneung-zoom", { center: JR, zoom: 16.0 });
// 04 상위 필지 선택 + 상세
await shot("04-parcel-detail", {
  center: JR, zoom: 16.4, settle: 5000,
  setup: (pg) => pickJeongneung(pg, "800-20"),
});
// 05 tol=0 순수 사업성
await shot("05-tolerance-0", {
  center: JR, zoom: 15.4,
  setup: async (pg) => { await setRange(pg, "tol1", 0); await setRange(pg, "tol2", 0); },
});
// 06 tol=20 일조·역세권 지배
await shot("06-tolerance-20", {
  center: JR, zoom: 15.4,
  setup: async (pg) => { await setRange(pg, "tol1", 20); await setRange(pg, "tol2", 25); },
});
// 07 제외 필지 표시
await shot("07-excluded-parcels", {
  center: JR, zoom: 16.0,
  setup: async (pg) => { await pg.check("#showEx"); await pg.waitForTimeout(1400); },
});
// 08 다세대 제외
await shot("08-exclude-subdivided", {
  center: JR, zoom: 15.4,
  setup: async (pg) => { await pg.check("#exSub"); await pg.waitForTimeout(1400); },
});
// 09 임대료 하향 시나리오
await shot("09-low-rent-scenario", {
  center: JR, zoom: 15.4,
  setup: async (pg) => { await setRange(pg, "rent", 45); await setRange(pg, "minRooms", 30); },
});
// 10 정릉동 남부 + 다크모드
await shot("10-dark-mode", { center: JR_S, zoom: 16.0, theme: "dark" });
// 11 모바일
await shot("11-mobile", { w: 414, h: 896, center: JR, zoom: 15.6 });

await browser.close();
console.log("완료");
