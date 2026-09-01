/* 웹 검증 스위트 (T-507 / T-502 완료조건).
 *
 * 1) 부팅·콘솔 에러
 * 2) JS 점수 엔진이 Python 과 같은 순위를 내는가  ← 가장 중요
 * 3) 파라미터 상호작용
 * 4) 선택·상세 패널
 * 5) 다크모드 / 반응형 / 접근성
 *
 * 실패가 하나라도 있으면 종료 코드 1.
 * 사용: node tools/verify_ui.mjs [baseUrl]
 */
import { chromium } from "playwright-core";
import { readFileSync, writeFileSync } from "node:fs";

const BASE = process.argv[2] || "http://127.0.0.1:8899/";
const fails = [];
const ok = (label, pass, detail = "") => {
  console.log(`  ${pass ? "✅" : "❌"} ${label}${detail ? "  " + detail : ""}`);
  if (!pass) fails.push(label);
};

const browser = await chromium.launch({
  channel: "chrome", headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--hide-scrollbars"],
});

async function newPage(w = 1440, h = 900) {
  const pg = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const errors = [];
  pg.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  pg.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  pg.errors = errors;
  await pg.goto(BASE, { waitUntil: "domcontentloaded" });
  await pg.waitForFunction(() => document.getElementById("boot")?.hidden === true,
    null, { timeout: 60000 });
  await pg.waitForFunction(() => !!window.__map && window.__map.loaded(), null, { timeout: 60000 });
  return pg;
}

// ── 1. 부팅 ───────────────────────────────────────────────
console.log("\n1) 부팅");
const pg = await newPage();
const boot = await pg.evaluate(() => ({
  cand: window.__state.result.order.length,
  rows: document.querySelectorAll("#listBody .row").length,
  canvas: !!document.querySelector("#map canvas"),
  layers: window.__map.getStyle().layers.map((l) => l.id),
}));
ok("후보 산출", boot.cand === 4894, `${boot.cand.toLocaleString()}`);
ok("리스트 렌더", boot.rows === 60, `${boot.rows}행`);
ok("지도 캔버스", boot.canvas);
ok("필지 레이어 존재", boot.layers.includes("parcel-fill"));
ok("역 레이어 존재", boot.layers.includes("stn-dot") && boot.layers.includes("stn-label"));
ok("콘솔 에러 없음", pg.errors.length === 0, pg.errors.slice(0, 2).join(" | "));

// ── 2. Python 대조 (핵심) ────────────────────────────────
console.log("\n2) Python 순위 대조 (T-502 완료조건)");
const jsTop = await pg.evaluate(() => {
  const s = window.__state;
  return s.result.order.slice(0, 200).map((i) => s.D.ids[i]);
});
const jsMetrics = await pg.evaluate(() => {
  const s = window.__state, r = s.result;
  const c = r.order;
  return {
    n: c.length,
    medS1: [...c].map((i) => r.s1[i]).sort((a, b) => a - b)[Math.floor(c.length / 2)],
    gradeCount: c.reduce((m, i) => (m[r.grade[i]] = (m[r.grade[i]] || 0) + 1, m), {}),
  };
});
const pyTop = readFileSync("data/interim/_py_top200.txt", "utf8").trim().split("\n");
const same = jsTop.filter((x) => pyTop.includes(x)).length;
const order = jsTop.filter((x, k) => x === pyTop[k]).length;
ok("상위200 집합 일치", same === 200, `${same}/200`);
ok("상위200 순서 일치", order === 200, `${order}/200`);
ok("후보 수 일치", jsMetrics.n === 4894, `${jsMetrics.n}`);
ok("중위 수익률 3.9%대", Math.abs(jsMetrics.medS1 - 0.039) < 0.002,
  `${(jsMetrics.medS1 * 100).toFixed(2)}%`);
writeFileSync("/tmp/js_top200.txt", jsTop.join("\n"));

// ── 3. 파라미터 상호작용 ──────────────────────────────────
console.log("\n3) 파라미터");
const setRange = async (id, v) => {
  await pg.evaluate(([i, val]) => {
    const el = document.getElementById(i);
    el.value = String(val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, [id, v]);
  await pg.waitForTimeout(320);
};
const candNow = () => pg.evaluate(() => window.__state.result.order.length);

await setRange("minRooms", 60);
const c60 = await candNow();
ok("최소 실 수 60 → 후보 감소", c60 < 4894 && c60 > 0, `${c60.toLocaleString()}`);
await setRange("minRooms", 20);
ok("최소 실 수 복귀", (await candNow()) === 4894);

await setRange("rent", 40);
const lowRent = await pg.evaluate(() => {
  const s = window.__state, r = s.result;
  return r.s1[r.order[0]];
});
ok("임대료 40만원 → 수익률 하락", lowRent < 0.045, `1위 ${(lowRent * 100).toFixed(2)}%`);
await setRange("rent", 66);

await setRange("tol1", 0);
const tol0 = await pg.evaluate(() => {
  const s = window.__state, r = s.result;
  const arr = r.order.map((i) => r.s1[i]);
  let viol = 0;
  for (let k = 1; k < arr.length; k++) if (arr[k] > arr[k - 1] + 1e-12) viol++;
  return viol;
});
ok("tol=0 → S₁ 단조 비증가", tol0 === 0, `위반 ${tol0}건`);
await setRange("tol1", 5);

// 등급 임계 단조성 강제
await setRange("gA", 600);
const grades = await pg.evaluate(() => ["gA", "gB", "gC", "gD"].map((i) => +document.getElementById(i).value));
ok("등급 임계 단조 증가 강제", grades.every((v, k) => k === 0 || v > grades[k - 1]), grades.join(" < "));

await pg.click("#reset");
await pg.waitForTimeout(320);
const afterReset = await pg.evaluate(() => ({
  cand: window.__state.result.order.length,
  rent: document.getElementById("rent").value,
  gA: document.getElementById("gA").value,
}));
ok("되돌리기", afterReset.cand === 4894 && afterReset.rent === "66" && afterReset.gA === "250");

// 다세대 제외 토글
await pg.check("#exSub");
await pg.waitForTimeout(320);
const exSub = await candNow();
ok("다세대 제외 토글", exSub === 4894 - 1141, `${exSub.toLocaleString()} (=4894-1141)`);
await pg.uncheck("#exSub");
await pg.waitForTimeout(320);

// 제외 필지 표시
await pg.check("#showEx");
await pg.waitForTimeout(400);
const exPaint = await pg.evaluate(() =>
  JSON.stringify(window.__map.getPaintProperty("parcel-fill", "fill-opacity")));
ok("제외 필지 표시 토글", exPaint.includes("0.42"));
await pg.uncheck("#showEx");

// ── 4. 선택·상세 ─────────────────────────────────────────
console.log("\n4) 선택 · 상세");
await pg.waitForTimeout(300);
await pg.click("#listBody .row:first-child");
await pg.waitForTimeout(900);
const det = await pg.evaluate(() => ({
  hidden: document.getElementById("detail").hidden,
  name: document.getElementById("detailName").textContent,
  keys: [...document.querySelectorAll("#detailBody dt")].map((d) => d.textContent),
  selected: window.__state.selected,
  aria: document.querySelector('#listBody .row[aria-selected="true"]')?.dataset.id,
}));
ok("상세 패널 열림", det.hidden === false);
ok("상세 제목", det.name.length > 2, det.name);
ok("상세 항목", det.keys.includes("순위") && det.keys.includes("총사업비") && det.keys.includes("철거비"),
  `${det.keys.length}개 항목`);
ok("리스트 선택 동기화", det.aria === det.selected);

await pg.keyboard.press("Escape");
await pg.waitForTimeout(200);
ok("Escape 로 상세 닫힘", await pg.evaluate(() => document.getElementById("detail").hidden === true));

// ── 5. 다크모드 ──────────────────────────────────────────
console.log("\n5) 다크모드 · 접근성");
await pg.click("#themeBtn");
await pg.waitForTimeout(300);
const dark = await pg.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  return {
    theme: document.documentElement.dataset.theme,
    surface: cs.getPropertyValue("--surface").trim(),
    ink: cs.getPropertyValue("--ink").trim(),
  };
});
ok("다크모드 전환", dark.theme === "dark" && dark.surface === "#1a1a19", `${dark.surface} / ${dark.ink}`);
await pg.click("#themeBtn");
await pg.waitForTimeout(200);
ok("라이트 복귀", await pg.evaluate(() => document.documentElement.dataset.theme === "light"));

// 대비 (WCAG AA 4.5:1)
const contrast = await pg.evaluate(() => {
  const lum = (c) => {
    const [r, g, b] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map((v) => {
      v = +v / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const bg = getComputedStyle(document.body).backgroundColor;
  const out = {};
  const probe = (sel, name) => {
    const el = document.querySelector(sel); if (!el) return;
    const cs = getComputedStyle(el);
    let b = cs.backgroundColor;
    if (b === "rgba(0, 0, 0, 0)") b = bg;
    out[name] = +ratio(cs.color, b).toFixed(2);
  };
  probe("header h1", "제목");
  probe(".ctl label", "슬라이더 라벨");
  probe(".row .nm", "후보명");
  probe(".row .yield", "수익률");
  probe(".btn", "버튼");
  probe(".badge", "가정 배지");
  probe("#legend .ttl", "범례 제목");
  document.getElementById("aboutBtn").click();
  probe("#about .p", "출처 패널 본문");
  probe("#about .p.small", "출처 패널 각주");
  document.getElementById("aboutClose").click();
  return out;
});
for (const [k, v] of Object.entries(contrast)) ok(`대비 ${k}`, v >= 4.5, `${v}:1`);

// 포커스 링
const focus = await pg.evaluate(() => {
  const el = document.getElementById("tol1"); el.focus();
  const cs = getComputedStyle(el, ":focus-visible");
  return { active: document.activeElement?.id, outline: cs.outlineWidth };
});
ok("키보드 포커스", focus.active === "tol1");

// 언어·타이틀·메타
const meta = await pg.evaluate(() => ({
  lang: document.documentElement.lang,
  title: document.title,
  desc: document.querySelector('meta[name="description"]')?.content?.length,
  emdash: document.body.innerText.includes("—") || document.body.innerText.includes("–"),
}));
ok("lang=ko", meta.lang === "ko");
ok("title 존재", meta.title.length > 5);
ok("description 존재", meta.desc > 20);
ok("em-dash 없음", meta.emdash === false);

// 출처·라이선스 표기 (T-604). SGIS 경계는 CC BY 4.0 이라 표기가 의무다.
const attrib = await pg.evaluate(() => {
  document.getElementById("aboutBtn").click();
  const t = document.getElementById("about").innerText;
  const map = document.querySelector(".maplibregl-ctrl-attrib")?.innerHTML || "";
  document.getElementById("aboutClose").click();
  return { t, map, hidden: document.getElementById("about").hidden };
});
ok("출처 패널 열림/닫힘", attrib.hidden === true);
ok("CC BY 4.0 표기", attrib.t.includes("CC BY 4.0"));
ok("SGIS 표기", attrib.t.includes("SGIS"));
ok("국토교통부 표기", attrib.t.includes("국토교통부"));
ok("OpenStreetMap 표기", attrib.t.includes("OpenStreetMap") || attrib.map.includes("OpenStreetMap"));
ok("가정 경고 문구", attrib.t.includes("투자 판단에 그대로 쓰면 안 됩니다"));
ok("지도 attribution 에 CC BY", attrib.map.includes("CC BY 4.0"));
// 라이선스 표기가 패널에 가려지면 안 된다
const attVis = await pg.evaluate(() => {
  const a = document.querySelector(".maplibregl-ctrl-attrib");
  if (!a) return { ok: false, why: "attribution 없음" };
  const r = a.getBoundingClientRect();
  const pt = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { ok: !!pt && (a === pt || a.contains(pt)), why: pt?.className || "" };
});
ok("attribution 가려지지 않음", attVis.ok, attVis.why);

// ── 6. 반응형 ────────────────────────────────────────────
console.log("\n6) 반응형");
for (const [w, h, label] of [[390, 844, "모바일"], [820, 1180, "태블릿"], [1920, 1080, "와이드"]]) {
  const p2 = await browser.newPage({ viewport: { width: w, height: h } });
  await p2.goto(BASE, { waitUntil: "domcontentloaded" });
  await p2.waitForFunction(() => document.getElementById("boot")?.hidden === true, null, { timeout: 60000 });
  await p2.waitForTimeout(1500);
  const r = await p2.evaluate(() => {
    const oflow = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    const rects = {};
    for (const id of ["params", "list", "legend"]) {
      const el = document.getElementById(id);
      if (el) { const b = el.getBoundingClientRect(); rects[id] = { x: Math.round(b.x), r: Math.round(b.right), w: Math.round(b.width) }; }
    }
    const inView = Object.values(rects).every((b) => b.x >= -2 && b.r <= innerWidth + 2);
    return { oflow, inView, rects };
  });
  ok(`${label} ${w}x${h} 가로 넘침 없음`, !r.oflow);
  ok(`${label} 패널 화면 안`, r.inView, JSON.stringify(r.rects));
  const ov = await p2.evaluate(() => {
    const R = (id) => { const e = document.getElementById(id); if (!e || e.hidden) return null;
      const b = e.getBoundingClientRect(); return b.width && b.height ? b : null; };
    const hit = (a, b) => a && b && a.left < b.right - 1 && b.left < a.right - 1
      && a.top < b.bottom - 1 && b.top < a.bottom - 1;
    const ids = ["params", "list", "legend"]; const bad = [];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++)
      if (hit(R(ids[i]), R(ids[j]))) bad.push(`${ids[i]}×${ids[j]}`);
    return bad;
  });
  ok(`${label} 패널 겹침 없음`, ov.length === 0, ov.join(", "));
  const mapVisible = await p2.evaluate(() => {
    const m = document.getElementById("map").getBoundingClientRect();
    const blocked = ["params", "list", "legend"].map((id) => {
      const e = document.getElementById(id); if (!e || e.hidden) return 0;
      const b = e.getBoundingClientRect(); return b.width * b.height;
    }).reduce((a, b) => a + b, 0);
    return 1 - blocked / (m.width * m.height);
  });
  ok(`${label} 지도 가시영역 40% 이상`, mapVisible > 0.4, `${(mapVisible * 100).toFixed(0)}%`);
  await p2.close();
}

// ── 7. 패널 겹침 ─────────────────────────────────────────
console.log("\n7) 레이아웃 겹침");
const overlap = await pg.evaluate(() => {
  document.querySelector("#listBody .row")?.click();
  const R = (id) => { const e = document.getElementById(id); if (!e || e.hidden) return null; const b = e.getBoundingClientRect(); return b.width ? b : null; };
  const hit = (a, b) => a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const ids = ["params", "list", "legend", "detail"];
  const bad = [];
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++)
      if (hit(R(ids[i]), R(ids[j]))) bad.push(`${ids[i]}×${ids[j]}`);
  return bad;
});
ok("패널 간 겹침 없음", overlap.length === 0, overlap.join(", "));

// ── 결과 ────────────────────────────────────────────────
console.log("\n" + "=".repeat(56));
if (fails.length) {
  console.log(`❌ 실패 ${fails.length}건:\n  - ${fails.join("\n  - ")}`);
} else {
  console.log("✅ 전 항목 통과");
}
await browser.close();
process.exit(fails.length ? 1 : 0);
