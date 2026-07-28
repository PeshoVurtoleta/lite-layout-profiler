# Changelog

## 1.4.0

The coverage lane's remaining half: foreign-patch provenance. v1.3's
identity-checked restore already refused to clobber a wrapper layered on top of
ours. This closes the other side -- detecting, at instrument time, that a target
was already wrapped, so `summary().patched` stops claiming complete coverage it
does not have.

### Added

- **`summary().patched.foreign`** -- count of targets verifiably already wrapped
  by another lite-layout-profiler instance when we instrumented (a second
  profiler, a leaked prior run, a double init).
- **`summary().patched.provenance`** -- a per-target map of every non-clean
  target to `'foreign'` (verified) or `'unknown'`. Clean targets are omitted.
- **`patched.complete` now accounts for foreign patches.** It is true only when
  every present target is owned by us and nothing else. Because the gate's
  existing "incomplete coverage -> unverifiable" path reads `complete`, a run
  instrumented on top of a foreign wrapper flips the affected per-record rules
  to unverifiable automatically -- no new rule, no new key.

### How detection works, and its honest limit

Every wrapper we install is stamped with a non-enumerable brand
(`Symbol.for('lite-layout-profiler.wrapper')`) carrying the installing
instance's id. At instrument time, reading that brand off the value already in
the slot is a certain signal: our own id (a re-entrant/leaked run, treated as
clean-owned), a different id (**verified foreign**), or absent.

The limit is deliberate and measured, not assumed: an **unbranded** pre-existing
wrapper -- a framework hook, a non-lite profiler -- cannot be told apart from a
host's pristine implementation by inspection. In happy-dom and jsdom the
pristine impls are ordinary JS functions with no `[native code]` marker, so any
"is this native?" heuristic would flag every pristine getter as foreign. That
false positive on a clean host is exactly the noise a coverage check must avoid,
so an unbranded wrapper is **never** asserted foreign. The lane reports only what
it can verify.

### Fixed / learned

- **Stacked instances must tear down last-in-first-out.** Wrappers stack, so an
  inner instance destroyed before an outer one cannot restore (the slot holds
  the outer wrapper) and leaves an orphaned brand. This surfaced through the
  identity-checked restore and is now covered by torture; the guidance is to
  destroy profilers in reverse creation order.

### Testing

28 new scenarios: 11 standard (`test/07-provenance.test.mjs`) and 17 torture
(`test/torture/l4-5-provenance.test.mjs`, axes A-D). Axis A is the false-positive
guard asserted directly -- an unbranded wrapper and every pristine getter must
never be called foreign. Full suite: 283 tests.

## 1.3.0

The phase lane. v1.2 counts a forced reflow the same wherever it fires; v1.3
knows a reflow inside `requestAnimationFrame` stalls the exact frame it is
rendering, and lets you gate that separately from a merely-bad one in a timer.

### Added

- **Phase classification** (opt-in via `{ phases: true }`). Wraps the
  schedulers -- `requestAnimationFrame`, `setTimeout`/`setInterval`,
  `queueMicrotask`/`Promise.prototype.then`, `ResizeObserver` -- so each reflow
  is stamped with the phase it fired under: `raf`, `timer`, `microtask`,
  `ro-callback`, or `unknown`. Records gain `phase` and `roFeedback`; the
  summary gains `phases` (per-phase counts), `phasesObserved`, `thrash`, and
  `maxThrashCount`.
- **Rule `maxInRaf`** -- max forced reflows inside rAF callbacks. `maxInRaf: 0`
  is the "never force layout during render" assertion, the one with a hard
  physical meaning (the browser cannot paint mid-rAF-block).
- **Thrash collapsing** -- an identical `(read, write, readSite, writeSite,
  taskId)` tuple repeating within one task folds into one `summary().thrash`
  group with a `count`, so a getter read in a 10 000-iteration loop is one
  finding, not 10 000. Rule **`maxThrash`** gates the worst collapsed count.
  Does NOT require `{ phases: true }`.
- **ResizeObserver feedback-loop detection** -- a reflow inside an RO callback
  whose body already wrote layout (the self-perpetuating shape) is flagged
  `roFeedback: true`.

### Why phases are opt-in and fail-closed

Wrapping `requestAnimationFrame` et al. touches globals every scheduled
callback in the page runs through -- a broader footprint than the read/write
prototype patches -- so it is off by default. With it off, every record is
phase `'unobserved'` and `maxInRaf` gates as **unverifiable**, never a pass:
you cannot assert "no reflow in rAF" if rAF was never watched. And
`phasesObserved` reports whether `requestAnimationFrame` was *actually*
wrapped, not merely whether the option was set -- on a host with no rAF (a
worker, an older runtime) `maxInRaf` stays unverifiable rather than falsely
green. A phase we did not wrap is reported as `'unknown'`, never guessed
into `'raf'`.

### Design notes

- **`summary().records` stays the raw one-record-per-reflow view.** Collapsing
  there would make `maxReflows` count groups instead of reflows; thrash is a
  separate, additive `summary().thrash` field, and the gate's counting is
  unchanged.
- **Nested schedulers report the innermost active phase**, via a small phase
  stack pushed/popped in a `finally` -- a throwing callback cannot strand the
  phase, the same discipline the dirty flag learned in v1.2.
- **Teardown restores every wrapped scheduler by identity**: a restore fires
  only if the current binding is still our wrapper, so `destroy()` never
  deletes a foreign scheduler shim layered on top. Wrappers are installed on
  both the `globalThis` and `window` bindings when they differ, so an
  unqualified `requestAnimationFrame(...)` and `window.requestAnimationFrame(...)`
  both route through them.

### Fixed (baseline corrections shipped with this release)

These predate v1.3 and came in with the earlier double-patch recovery; a new
release is the honest moment to correct them.

- **VERSION mismatch.** HEAD shipped `package.json` at `1.2.1` while
  `LayoutProfiler.js` reported `1.2.0`. There was no `1.2.1` changelog entry
  or feature; this release supersedes that phantom bump.
- **Duplicate test file.** `test/layout.test.mjs` was a byte-for-byte copy of
  `test/01-detect.test.mjs` and was matched by the test glob, so the detect
  suite ran twice and inflated the reported count. Removed.
- **Stale pre-rename orphans.** `test/03-gate.test.js` and
  `test/04-gate-live.test.js` were `.js` fossils from before the
  `NN-name.test.mjs` rename -- not run by the glob, and one still asserted
  `maxCostMs` was a future-lane rule (wrong since v1.2). Removed.

### Testing

254 tests. New: `test/06-phase.test.mjs` (22 standard-case) and
`test/torture/l4-5-phase.test.mjs` (26 across axes A-E, including scheduler
teardown by identity, a foreign shim layered on top, a host with no
schedulers, and a throwing scheduled callback). The torture caught a real gap:
`phasesObserved` originally reported intent (`phases: true`) rather than
whether rAF actually wrapped, which would have made `maxInRaf` falsely
verifiable on a rAF-less host.

## 1.2.0

The cost lane. v1.1 could fail a build over a count; v1.2 can fail one over
milliseconds -- and refuses to invent a number it could not measure.

### Added

- **Cost measurement.** Every forced read is now timed across the original
  getter, so `costMs` is the stall itself and not the bookkeeping around it.
  `Violation` gains `costMs: number | null` and `belowGranularity: boolean`.
- **Timer resolution probe.** Runs once at init, budgeted to 2 ms and 8
  samples. `summary().cost.resolutionMs` reports the clock floor, or `null`
  when it could not be determined.
- **`summary().cost`** -- `{ resolutionMs, measured, unmeasured, totalMs,
  maxMs, avgMs, p99Ms }`. Percentiles are computed over measured costs only.
- **Rules `maxCostMs` and `maxTotalCostMs`** -- worst single stall and total
  stall, both evaluated after allowlist exclusions.
- **`GateReport.cost`** -- `{ measured, unmeasured, totalMs, maxMs }` over
  counted reflows, or `null` when the summary carried no records.
- **`options.measureCost`** (default `true`) -- skips the init probe and the
  two clock reads per violation. Pair with `captureStacks: false` for the
  CI-counting configuration: no stack allocation, no timing, just counts.
- **`options.clock`** -- a monotonic millisecond clock, defaulting to
  `performance.now()`. For hosts without `performance`, and so tests can drive
  a clock of known granularity rather than hoping the host's is coarse.

### Changed

- **Records live in a fixed-size ring.** v1.1 used a plain array with
  `shift()` on overflow, which is O(N) per drop once full -- a real cost in
  exactly the thrashing runs this tool is pointed at. The ring writes in place
  and never moves an element. Retention is unchanged: the newest `maxStored`
  records are kept.
- **`profiler.violations` is now a stable snapshot**, cached until the next
  capture, rather than the live internal array. Holding a reference across
  further reflows no longer mutates under you.
- `summary().records` carry `costMs` and `belowGranularity`.

### Design notes

**Null is not zero.** Browsers deliberately coarsen `performance.now()`: a
non-isolated Chrome tab clamps to 100us, Firefox to 1ms by default. A reflow
shorter than that reads back as exactly `0`, indistinguishable from free.

A stall must exceed **more than one tick** to be recorded as a number. One
tick is not a small measurement, it is an absent one: a delta of exactly one
tick means the true duration lies somewhere in `(0, 2 x tick)`, an interval
that contains zero, so it is not a lower bound at all. Only from two ticks up
does the measurement carry a positive lower bound. Anything at or below one
tick is `costMs: null` with `belowGranularity: true`.

Aggregates follow the same rule. With `measured === 0`, `totalMs`, `maxMs`,
`avgMs` and `p99Ms` are all `null`, never `0`.

**Cost rules refuse to guess.** If any counted reflow carries no cost,
`maxCostMs` and `maxTotalCostMs` fail as unverifiable rather than summing the
nulls as zeroes -- otherwise a thousand sub-resolution stalls would slide
under a millisecond budget. On a coarse-clocked browser this means cost
budgets simply do not apply and you gate on counts instead. You cannot pass a
budget you were never able to measure.

The evidence matrix from 1.1 gains one row:

| rule | needs | unverifiable when |
| --- | --- | --- |
| `maxReflows` | `summary.total` | never -- the count is exact |
| `maxPerTask` | complete records | records truncated or absent |
| `allowReads` / `allowWrites` | complete records | records truncated or absent |
| `ignoreSites` | complete records + call sites | above, or `captureStacks: false` |
| `maxCostMs` / `maxTotalCostMs` | measured costs | any counted reflow unmeasured |

**Two budgets, two illnesses.** Fifty reflows of 0.2 ms is a different problem
from one reflow of 12 ms, and only the second drops a frame on its own.
`maxCostMs` and `maxTotalCostMs` are deliberately separate so a run can breach
one while passing the other.

### Hardening (torture suite)

A 105-scenario adversarial suite landed alongside the cost lane
(`test/torture/`, documented in `TORTURE.md`). It found 22 defects on its
first run, all fixed here. The ones that mattered most:

- **A callback that read a layout property recursed without bound.** The
  dirty flag was cleared *after* `onViolation` fired, so the callback's own
  read was itself a violation, which fired the callback again. A debug overlay
  reading `offsetWidth` was enough to blow the stack. The flag is now cleared
  before any user code runs, which also stops a throwing callback from
  stranding it and turning every later read in the task into a phantom.
- **A frozen or non-configurable prototype crashed the constructor**, and
  worse, there was no way to tell a host that refused half the patch net from
  a page that genuinely forces no layout. Both now degrade instead of
  throwing, and `summary().patched` reports coverage.
- **Teardown deleted foreign patches.** Restores wrote saved originals back
  unconditionally, so destroying this profiler removed any instrumenter that
  had patched on top of it. Every restore is now identity-checked: the
  profiler declines to unpatch what it no longer owns.
- **`NaN` cost counted as a measurement.** `typeof NaN === 'number'` and NaN
  compares false against every limit, so a corrupted report passed any cost
  budget in silence. Infinite and negative costs had the same hole.
- **Rule values were read through the prototype chain** while validation
  walked own keys only, so `Object.create({ maxReflows: -5 })` applied an
  unvalidated limit.
- **Storage caps were coerced rather than validated.** `maxStored: 0` silently
  became 200, `1.5` and `Infinity` threw `RangeError` out of `new Array()`.

### Added

- **`summary().patched`** -- `{ applied, failed, skipped, complete, failures }`.
  A host can refuse to be patched, and a detector with holes in its net
  reports zero reflows for the same reason a working one does. `skipped` is
  deliberately separate from `failed`: a target absent from this host (no
  `DOMTokenList`, no SVG) is not a hole, because nothing can flow through a
  path the host does not have. Collapsing the two would make every minimal
  environment look torn, which is how a coverage check becomes noise everyone
  learns to ignore.
- **Gate rule `patched`** -- `complete: false` makes every rule unverifiable at
  once, not one of them. A read that was never instrumented cannot appear in
  `total`, so even the exact count is a floor rather than a number. A summary
  without a `patched` block is gated as before, so pre-1.2 reports still work.

### Changed

- **`maxStored` is validated**: an integer in `1..1000000`, or a `TypeError`
  naming the option. `maxViolations` is validated identically.
- **`options.clock` is only adopted when `measureCost` is on.** The clock
  exists to serve the cost lane; with timing off there is nothing for it to
  do, and a caller who switched timing off should not still be exposed to a
  clock that throws.
- **A non-function `onViolation` is ignored** rather than called.
- **`reset()` clears the slots in use**, not the whole capacity.
- Costs must be finite and non-negative to count as measurements, in the
  profiler and in the gate alike.

### Testing

205 tests. 100 in the main suite, renumbered to the ecosystem
`NN-name.test.mjs` convention:
`01-detect`, `02-gate`, `03-gate-live`, `04-cost`, `05-cost-live`.
Plus 105 torture scenarios in `test/torture/` across nine axes; see
`TORTURE.md`. `npm test` runs both globs.

The live cost suite drives the real patcher against a stub DOM with an
injected clock, so timer-resolution behaviour is deterministic instead of
depending on how fine the host's clock happens to be.

### Docs

- **COOKBOOK.md** added: 16 recipes in four tiers, plus the evidence matrix
  and CI workflow diagrams.
- README gains a Cost section; `llms.txt` rewritten for the three lanes.
- The demo shows the cost lane and a live gate verdict with editable budgets.
  Its own repaint is now deferred to a `requestAnimationFrame` and excluded via
  `ignorePatterns`, so the profiler's UI writes cannot dirty layout inside the
  task being measured.

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
