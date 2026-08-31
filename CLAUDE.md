# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

# 프로젝트 규칙 — 임대형기숙사 적합 필지 탐색 (성북구)

## 세션 시작 시

`docs/ROADMAP.md`, `docs/DECISIONS.md`, `docs/METHODOLOGY.md`, `config/params.yaml` 을 먼저 읽는다.
이 4개 문서가 프로젝트의 맥락 전부를 담고 있다.

## 문서가 코드보다 우선한다

`docs/METHODOLOGY.md` 가 사양서다. 코드는 그것의 구현일 뿐이다.
- 방법이 바뀌면 **문서를 먼저 고치고** 코드를 따라 고친다.
- 문서의 정의에 빈틈이 보이면 **임의로 메우지 말고** 지적하고 물어본다.
- 되돌리기 어려운 선택을 했으면 `docs/DECISIONS.md` 에 기록한다.

## 공간분석 규칙

- **거리·면적 계산은 EPSG:5186** 에서 한다. 위경도(EPSG:4326)로 거리를 계산하지 않는다.
- 조인할 때는 **조인율을 출력**한다. 결측 행을 말없이 버리지 않는다.
- 필지는 6~8만 개다. 행 단위 `for` 루프나 `df.apply()` 를 쓰지 않는다.
  공간 연산은 STRtree 색인 + numpy 벡터화로 한다.
- 무거운 중간 결과는 `data/interim/` 에 캐시한다.

## 파라미터

- 숫자를 코드에 하드코딩하지 않는다. 전부 `config/params.yaml` 에서 읽는다.
- 새 가정을 도입하면 params.yaml 에 항목을 추가하고 **근거 또는 "미결" 표시**를 주석으로 남긴다.

## 웹 규칙

- **점수를 미리 계산해서 타일에 굽지 않는다.** raw 지표값만 넣고 브라우저에서 계산한다.
  이걸 어기면 파라미터 슬라이더가 동작하지 않는다.
- 타일 속성은 10개 내외로 제한한다 (파일 크기).
- 외부 유료 서비스에 의존하지 않는다. 지도는 MapLibre(토큰 불필요), 호스팅은 GitHub Pages.
- 디자인은 `.claude/skills/taste-skill/SKILL.md` 를 따른다.
  단 이 스킬은 랜딩·포트폴리오용이고 대시보드는 명시적 제외 범위다.
  **시각 언어만 차용하고 레이아웃은 지도 대시보드 관례를 따른다.**

## 결과를 다룰 때

이 분석의 출력은 부동산 의사결정에 쓰일 수 있다. 따라서:
- 검증되지 않은 가정으로 나온 숫자를 확정된 사실처럼 제시하지 않는다.
- 지표 분포가 상식을 벗어나면 (예: 수익률 40%) 넘어가지 말고 원인을 먼저 찾는다.
- 결과물에는 항상 데이터 기준연도와 가정의 한계를 함께 표시한다.
