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
const TWO = [127.0175, 37.5900];      // 성북·성동 두 구가 함께 들어오는 뷰
const SD = [127.0430, 37.5560];       // 성동구 전경
const SS = [127.0455, 37.5445];       // 성수역 일대

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
/* 필지를 눌러 상세를 연다.
   성동구를 붙이면서 필지명에 자치구 접두가 생겼는데(`성북구 정릉동 800-20`)
   여기가 완전일치라 조용히 아무것도 안 하고 빈 화면을 찍고 있었다.
   접미 일치로 바꾸고, 못 찾거나 패널이 안 열리면 던진다. */
const pickParcel = async (pg, name) => {
  const opened = await pg.evaluate(async (nm) => {
    const s = window.__state;
    const i = s.D.names.findIndex((n) => n === nm || n.endsWith(" " + nm));
    if (i < 0) return { ok: false, why: `필지 '${nm}' 없음` };
    const id = s.D.ids[i];
    // 목록은 상위 60행만 보여 준다. 자치구를 늘리면 특정 필지가 목록 밖으로
    // 밀려나므로 행 클릭에 의존하지 않고 앱의 선택 함수를 직접 부른다.
    const hit = [...document.querySelectorAll("#listBody .row")]
      .find((r) => r.dataset.id === id);
    if (hit) hit.click();
    else window.__selectParcel(id, true);
    await new Promise((r) => setTimeout(r, 2600));
    return { ok: !document.getElementById("detail").hidden, why: "상세 패널이 안 열림" };
  }, name);
  if (!opened.ok) throw new Error(`캡처 실패: ${opened.why}`);
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
  setup: (pg) => pickParcel(pg, "정릉동 800-20"),
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

// 12 성북·성동 두 자치구
await shot("12-two-districts", { center: TWO, zoom: 11.9 });
// 13 성동구 전경
await shot("13-seongdong-area", {
  center: SD, zoom: 13.2,
  setup: async (pg) => { await pg.selectOption("#sggSel", "11200"); await pg.waitForTimeout(1200); },
});
// 14 성수역 일대 확대
await shot("14-seongsu-zoom", {
  center: SS, zoom: 15.2,
  setup: async (pg) => { await pg.selectOption("#sggSel", "11200"); await pg.waitForTimeout(1200); },
});
// 15 성동구 · 임대료 85만원 (기본값이므로 슬라이더를 명시적으로 확인)
await shot("15-seongdong-rent85", {
  center: SS, zoom: 14.4,
  setup: async (pg) => {
    await pg.selectOption("#sggSel", "11200");
    await pg.waitForTimeout(1200);
    await setRange(pg, "rent", 85);
  },
});
// 16 합필 — 성수동2가 299-19 외 4필지.
// 도형은 화면에 있는 타일에서만 정확히 읽힌다. 필지 위로 맞춘 뒤 담아야
// 실현계수가 "근사" 가 아닌 실제 값으로 나온다.
// 담는 것도 앱의 실제 경로(__asmToggle)로 한다. state.asm 을 직접 건드리면
// 칠하기(paintAsm)를 건너뛰어 지도에 강조가 안 나온다.
await shot("16-assembly", {
  center: [127.0555, 37.5432], zoom: 17.0, settle: 4000,
  setup: async (pg) => {
    await pg.selectOption("#sggSel", "11200");
    await pg.waitForTimeout(1200);
    const ids = await pg.evaluate(() => {
      const s = window.__state;
      const i = s.D.names.findIndex((n) => n === "성동구 성수동2가 299-19");
      if (i < 0) throw new Error("성수동2가 299-19 를 못 찾음");
      const grp = [i, ...(s.D.adj[i] || []).slice(0, 4)];
      const b = grp.reduce((acc, k) => acc.extend([s.D.lon[k], s.D.lat[k]]),
        new maplibregl.LngLatBounds([s.D.lon[i], s.D.lat[i]], [s.D.lon[i], s.D.lat[i]]));
      window.__map.fitBounds(b, { padding: { top: 90, bottom: 110, left: 400, right: 400 }, duration: 0 });
      return grp.map((k) => s.D.ids[k]);
    });
    await pg.waitForTimeout(4500);          // 타일이 실제로 그려질 때까지
    const st = await pg.evaluate((list) => {
      document.getElementById("asmMode").checked = true;
      document.getElementById("asmMode").dispatchEvent(new Event("change", { bubbles: true }));
      for (const id of list) window.__asmToggle(id);
      const f = window.__map.getFilter("parcel-asm");
      return {
        n: window.__state.asm.length,
        open: !document.getElementById("asm").hidden,
        exact: !!(window.__lastAsm && window.__lastAsm.exact),
        painted: Array.isArray(f) ? (f[2] && f[2][1] || []).length : 0,
      };
    }, ids);
    if (st.n !== 5 || !st.open) throw new Error(`캡처 실패: 합필 패널 ${JSON.stringify(st)}`);
    if (!st.exact) throw new Error("캡처 실패: 도형이 근사값 — 필지가 화면에 없다");
    if (st.painted !== 5) throw new Error(`캡처 실패: 지도 강조 ${st.painted}/5`);
    await pg.waitForTimeout(1500);
  },
});

// 17 거점 네트워크 (성동구). 합필 1곳을 고정하고 이격 1,500m 로 자동 보완한다.
// 합필은 16 과 같은 경로로 담는다. state.asm 을 직접 넣으면 도형이 근사값이 되어
// 같은 합필인데 16 과 수치가 어긋난다(4.27% vs 4.30%).
await shot("17-hub", {
  w: 1600, h: 1000, zoom: 12.2, settle: 1200,
  setup: async (pg) => {
    await pg.selectOption("#sggSel", "11200");
    await pg.waitForTimeout(1200);
    const ids = await pg.evaluate(() => {
      const s = window.__state;
      const i = s.D.names.findIndex((n) => n === "성동구 성수동2가 299-19");
      if (i < 0) throw new Error("성수동2가 299-19 를 못 찾음");
      const grp = [i, ...(s.D.adj[i] || []).slice(0, 4)];
      const b = grp.reduce((acc, k) => acc.extend([s.D.lon[k], s.D.lat[k]]),
        new maplibregl.LngLatBounds([s.D.lon[i], s.D.lat[i]], [s.D.lon[i], s.D.lat[i]]));
      window.__map.fitBounds(b, { padding: 120, duration: 0 });
      return grp.map((k) => s.D.ids[k]);
    });
    await pg.waitForTimeout(4500);          // 도형을 정확히 읽으려면 타일이 그려져야 한다
    const exact = await pg.evaluate((list) => {
      document.getElementById("asmMode").checked = true;
      document.getElementById("asmMode").dispatchEvent(new Event("change", { bubbles: true }));
      for (const id of list) window.__asmToggle(id);
      return !!(window.__lastAsm && window.__lastAsm.exact);
    }, ids);
    if (!exact) throw new Error("캡처 실패: 합필 도형이 근사값");
    await pg.evaluate(() => {
      document.getElementById("asmHub").click();
      document.getElementById("asmClose").click();
      const d = document.getElementById("hubD");
      d.value = "1500"; d.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await pg.waitForTimeout(400);
    await pg.click("#hubAuto");
    await pg.waitForTimeout(1500);
    // 거점이 전부 패널 사이 가시영역에 들어오도록 맞춘다
    const n = await pg.evaluate(() => {
      const s = window.__state, D = s.D;
      const pts = s.sites.map((x) => {
        let lo = 0, la = 0, a = 0;
        for (const i of x.indices) { lo += D.lon[i] * D.area[i]; la += D.lat[i] * D.area[i]; a += D.area[i]; }
        return [lo / a, la / a];
      });
      const b = pts.reduce((acc, p) => acc.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
      window.__map.fitBounds(b, { padding: { top: 110, bottom: 130, left: 400, right: 700 }, duration: 0 });
      return s.sites.length;
    });
    if (n !== 5) throw new Error(`캡처 실패: 거점 ${n}/5 곳`);
    await pg.waitForTimeout(2500);
  },
});

await browser.close();
console.log("완료");
