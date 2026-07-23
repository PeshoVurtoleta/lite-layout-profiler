# Changelog

## 1.1.0

The gate lane. v1.0 could tell you a forced reflow happened; v1.1 can fail a
build over it.

### Added

- **`checkNoReflow(summary, rules)`** -- evaluates a recorded run against a
  reflow budget and returns `{ ok, verified, total, counted, excluded,
  excludedBy, violations }`. The `violations` entries use the
  `{ metric, limit, actual, reason }` shape that `lite-gc-profiler`'s
  `checkNoGc` emits, so both profilers speak one language to `lite-perf-gate`
  and CI tooling.
- **`assertNoReflow(summary, rules)`** -- the same check, throwing
  `ReflowBudgetError` on breach. The error carries `.report` and `.violations`.
- **`ReflowBudgetError`** -- exported, `instanceof Error`.
- **Rules:** `maxReflows` (default 0), `maxPerTask`, `allowReads`,
  `allowWrites`, `ignoreSites`.
- **`READ_NAMES`** -- the closed vocabulary of read names this build can emit,
  derived from the same lists the patcher uses so it cannot drift.
- **`Violation.taskId`** -- the epoch of the synchronous block a reflow
  occurred in, advanced by the microtask checkpoint that clears the dirty
  flag. This is what makes `maxPerTask` meaningful: ten reflows over ten
  frames is a different illness from ten in one block.
- **`options.maxStored`** -- the storage cap, renamed (see Deprecated).

### Changed

- **`summary()` is now self-sufficient and serialisable.** It carries
  `truncated`, `stacks`, `byTask`, `taskCount`, and a `records` snapshot
  alongside the existing fields. A summary can be JSON-serialised, shipped out
  of the browser, and gated by a process that never saw the profiler -- the
  shape the v1.6 CLI gate will consume. `records` is a snapshot, not a live
  reference to the internal array; full stacks stay on `profiler.violations`.

### Fixed

- **The non-browser no-op profiler had no `summary()`.** Calling
  `profiler.summary()` under node threw. It now returns a real, gate-shaped
  summary of an empty run.

### Deprecated

- **`options.maxViolations` is now `options.maxStored`.** The old name
  collided head-on with the gate rule of the same name meaning the opposite
  thing -- a budget of zero, not a buffer of 200. Both are accepted;
  `maxStored` is the name going forward. The gate rule is `maxReflows`.

### Design notes

**Fail-closed on unverifiable evidence.** Every rule declares what it needs.
If the summary cannot supply it, the rule fails as unverifiable rather than
passing on incomplete data, and `verified` goes false:

| rule | needs | unverifiable when |
| --- | --- | --- |
| `maxReflows` | `summary.total` | never -- the count is exact |
| `maxPerTask` | complete records | records truncated or absent |
| `allowReads` / `allowWrites` | complete records | records truncated or absent |
| `ignoreSites` | complete records + call sites | above, or `captureStacks: false` |

Zero counted reflows through a torn record set is not a clean run. Note that
`maxReflows` alone survives truncation intact, because `total` is an exact
count kept independently of the storage buffer -- a capped run can still be
gated on volume, just not on shape.

**Unknown rule keys throw.** A misspelled rule is a rule that silently never
fires, so `checkNoReflow` rejects unknown keys with a did-you-mean hint
(case-insensitive exact match first, then edit distance <= 2). Rules belonging
to lanes that have not shipped yet -- `maxCostMs`, `maxInRaf`,
`allowExpected` -- are recognised by name and report which lane and version
they need, instead of offering a nonsense spelling suggestion.

**Allowlist entries are validated too.** `allowReads` is checked against
`READ_NAMES`; an entry that matches nothing in the vocabulary is a typo that
would silently widen nothing while looking like it widened something, so it
throws with a suggestion. `allowWrites` is a prefix match
(`'CSSStyleDeclaration.'` allows every style write). `ignoreSites` is a
substring match against either call site, and is distinct from the existing
`ignorePatterns` option: `ignorePatterns` drops a reflow at capture time so it
is never recorded, `ignoreSites` excludes an already-recorded reflow at gate
time and reports the subtraction in `excludedBy`.

**Exclusions happen before counting, including for `maxPerTask`.** A record
excluded by an allowlist counts toward nothing, and is counted once even when
several allowlists match it.

### Testing

43 tests. `test/03-gate.test.js` covers rule semantics as pure functions over
synthetic summaries -- no DOM needed. `test/04-gate-live.test.js` drives the
real patcher against an inline stub DOM and asserts the differential that
makes the gate meaningful:

```
THRASH  : reflows=50   tasks=1   worstTask=50   verified=true   -> gate FAILS
BATCHED : reflows=0    tasks=0   worstTask=0    verified=true   -> gate PASSES
```

Same work, same element, same number of style writes. The thrashing loop reads
`offsetWidth` after each write and forces 50 synchronous layouts in one block;
the batched loop reads once up front and forces none.


## [1.0.0] - 2026-07-07

Initial release. Dev-mode forced-reflow detector.

### Added

- `createLayoutProfiler(options?)` -- patch Element/HTMLElement/Node/
  CSSStyleDeclaration prototypes to detect read-after-write forced reflows.
- Write tracking: `style.setProperty`, `style.removeProperty`, `style.cssText`,
  every per-property style setter on `CSSStyleDeclaration.prototype`
  (`style.width = 'X'` etc. -- ~400 properties patched at init),
  `className`, `classList.*`, `setAttribute`, `appendChild`, `innerHTML`,
  `textContent`, and more.
- Read detection: `offsetWidth/Height/Top/Left`, `clientWidth/Height`,
  `scrollWidth/Height`, `getBoundingClientRect`, `getComputedStyle`,
  `SVGGraphicsElement.getBBox` / `getCTM` / `getScreenCTM` for SVG
  dataviz code, `Element` and `window` scroll methods
  (`scrollIntoView`, `scrollTo`, `scrollBy`, `scroll`) which force
  layout to compute their destination, and `window.innerWidth`,
  `innerHeight`, `scrollX`, `scrollY`, `pageXOffset`, `pageYOffset`.
- Call-site attribution via `Error.stack` with parsed `readSite`/`writeSite`.
  Requires unminified code or sourcemaps for readable attribution;
  set `captureStacks: false` in busy environments to skip the
  per-write stack allocation.
- `onViolation` callback, `console.warn` logging, `ignorePatterns` filter.
- `summary()` aggregation by read property and write source.
- `destroy()` cleanly unpatches all prototypes in reverse order.
- `reset()` clears violations without unpatching.
- No-op profiler in non-browser environments (safe to import in SSR/node).
- Full `LayoutProfiler.d.ts`. 14 tests (3 node + 11 happy-dom).
- Interactive demo with six thrash patterns and live violation log.
