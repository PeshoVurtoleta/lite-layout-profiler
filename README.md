# @zakkster/lite-layout-profiler

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-layout-profiler.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-layout-profiler)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Hot%20path-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-layout-profiler?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-layout-profiler)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-layout-profiler?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-layout-profiler)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-layout-profiler?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-layout-profiler)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

> Dev-mode forced-reflow detector. The #1 silent frame killer, made visible.

Patches layout-triggering getters (`offsetWidth`, `getBoundingClientRect`, `getComputedStyle`, etc.), tracks DOM writes that invalidate layout, and flags read-after-write within the same synchronous task. Each violation is attributed to a call site via `Error.stack`.

```bash
npm install @zakkster/lite-layout-profiler
```

## Quick start

```js
import { createLayoutProfiler } from '@zakkster/lite-layout-profiler';

const profiler = createLayoutProfiler({
    onViolation(v) {
        // v.read:      'offsetWidth'
        // v.write:     'CSSStyleDeclaration.setProperty()'
        // v.readSite:  '  at updateSize (app.js:42:12)'
        // v.writeSite: '  at resizeHandler (app.js:38:5)'
    }
});

// Your app runs normally. Every forced reflow logs a console.warn
// with the read getter, write source, and call sites.

// Later:
console.table(profiler.summary().byRead);
profiler.destroy();  // unpatch everything
```

## What it detects

Forced synchronous layout happens when JavaScript writes to the DOM (changing styles, classes, tree structure) and then reads a layout property before the browser has a chance to batch the recalculation. The browser must stop and recalculate layout synchronously to return the correct value. This is invisible outside DevTools tracing and is the #1 cause of dropped frames in DOM-binding code.

```js
// BAD: write then read (forced reflow)
el.style.width = '100px';
const w = el.offsetWidth;  // browser must recalculate NOW

// GOOD: read then write (no forced reflow)
const w = el.offsetWidth;  // uses cached layout
el.style.width = (w + 10) + 'px';  // browser batches this
```

## What it patches

**Layout-triggering reads** (getters/methods that force synchronous layout):

- **HTML/Element metrics:** `offsetWidth`, `offsetHeight`, `offsetTop`, `offsetLeft`, `clientWidth`, `clientHeight`, `clientTop`, `clientLeft`, `scrollWidth`, `scrollHeight`, `scrollTop`, `scrollLeft`, `getBoundingClientRect()`
- **Computed style:** `getComputedStyle()`
- **SVG coordinate space:** `SVGGraphicsElement.getBBox()`, `getCTM()`, `getScreenCTM()` -- for reactive dataviz code
- **Scroll methods** (force layout to compute destination): `Element.scrollIntoView()`, `Element.scrollTo()`, `Element.scrollBy()`, `window.scrollTo()`, `window.scrollBy()`, `window.scroll()`
- **Window metrics:** `window.innerWidth`, `innerHeight`, `scrollX`, `scrollY`, `pageXOffset`, `pageYOffset`

**Layout-invalidating writes** (mutations that dirty layout):

`style.setProperty()`, `style.removeProperty()`, `style.cssText =`, **every per-property style setter** (`style.width = 'X'`, `style.height = 'Y'`, etc. -- ~400 properties patched at init), `className =`, `classList.add/remove/toggle/replace`, `setAttribute()`, `removeAttribute()`, `innerHTML =`, `outerHTML =`, `innerText =`, `textContent =`, `appendChild()`, `insertBefore()`, `removeChild()`, `replaceChild()`

Per-property style setters are patched separately from `setProperty()` because in real browsers the WebIDL per-property setters go through internal C++ that bypasses the JS-level `setProperty` method. Patching one does not catch the other; both are needed.

## Gate

Detection tells you a forced reflow happened. The gate decides whether the run
passes.

```js
import { createLayoutProfiler, assertNoReflow } from '@zakkster/lite-layout-profiler';

const profiler = createLayoutProfiler({ warnToConsole: false });

await runTheInteraction();

assertNoReflow(profiler.summary());   // throws ReflowBudgetError on any reflow
profiler.destroy();
```

The default budget is zero. One forced reflow fails the run.

```js
import { checkNoReflow } from '@zakkster/lite-layout-profiler';

const report = checkNoReflow(profiler.summary(), {
    maxReflows: 0,                       // total, after exclusions (default 0)
    maxPerTask: 1,                       // worst single synchronous block
    allowReads: ['getBoundingClientRect'],
    allowWrites: ['CSSStyleDeclaration.transform'],
    ignoreSites: ['node_modules/gsap']
});
// -> { ok, verified, total, counted, excluded, excludedBy, violations }
```

`report.violations` entries are `{ metric, limit, actual, reason }` -- the same
shape `lite-gc-profiler`'s `checkNoGc` emits, so both profilers report to CI
tooling in one vocabulary.

### The differential

Same element, same fifty style writes. The only difference is where the read
sits:

```
THRASH  : reflows=50   tasks=1   worstTask=50   verified=true   -> gate FAILS
BATCHED : reflows=0    tasks=0   worstTask=0    verified=true   -> gate PASSES
```

```js
// THRASH: read after each write -- 50 synchronous layouts in one block
for (let i = 0; i < 50; i++) {
    el.style.width = i + 'px';
    total += el.offsetWidth;
}

// BATCHED: read once up front -- none
let w = el.offsetWidth;
for (let i = 0; i < 50; i++) el.style.width = (w + i) + 'px';
```

`test/04-gate-live.test.js` asserts exactly this differential on every run.

### Why `maxPerTask` exists

Ten reflows spread across ten frames is a different illness from ten in one
block. Every record carries a `taskId` -- the epoch of the synchronous block it
occurred in, advanced by the microtask checkpoint that clears the dirty flag --
so the gate can name the pathology rather than just the volume:

```
maxPerTask: task #7 forced 3 reflows in one synchronous block, limit 1
```

### Fail-closed

Every rule declares what evidence it needs. If the summary cannot supply it,
the rule **fails as unverifiable** rather than passing on incomplete data, and
`report.verified` goes false:

| rule | needs | unverifiable when |
| --- | --- | --- |
| `maxReflows` | `summary.total` | never -- the count is exact |
| `maxPerTask` | complete records | records truncated or absent |
| `allowReads` / `allowWrites` | complete records | records truncated or absent |
| `ignoreSites` | complete records + call sites | above, or `captureStacks: false` |

An incomplete patch net invalidates every rule at once rather than one of
them: a read that was never instrumented cannot appear in `total`, so even the
exact count is a floor and not a number. `summary().patched` reports
`{ applied, failed, skipped, foreign, complete, provenance, failures }`, where
`skipped` means a target this host does not have (not a hole), `failed` means a
target that refused to be patched (a hole), and `foreign` (v1.4) means a target
that was already wrapped by another instrumenter when we got there.

**Foreign patches (v1.4).** If a second lite-layout-profiler instance -- a
leaked prior run, a double init, two profilers in one page -- has already
wrapped a target, patching on top of it works, but the reflows you record now
travel through code you do not own. `patched.foreign` counts those targets,
`patched.provenance` names them, and `patched.complete` goes false, so the gate
flips the affected per-record rules to unverifiable exactly as it does for a
failed patch. Detection is by a brand every wrapper carries, so it is certain
for another lite-layout-profiler instance. The honest limit: an *unbranded*
pre-existing wrapper (a framework hook, a non-lite tool) cannot be told apart
from a host's pristine implementation by inspection -- in jsdom and happy-dom
the pristine impls are ordinary JS with no `[native code]` marker -- so it is
never falsely reported foreign. The lane reports only what it can verify.

> **Tearing down stacked instances.** Wrappers stack, so destroy profilers in
> reverse creation order (last created, first destroyed). An inner instance
> destroyed first cannot restore -- the slot holds the outer wrapper -- and
> leaves an orphaned wrapper behind.

Zero counted reflows through a torn record set is not a clean run. If the
storage cap dropped records, any rule that reasons about individual records
refuses to evaluate -- but `maxReflows` still gates exactly, because `total` is
kept independently of the storage buffer. A capped run can be gated on volume,
just not on shape.

### Unknown rules throw

A misspelled rule is a rule that silently never fires:

```js
checkNoReflow(summary, { maxReflow: 0 });
// TypeError: Unknown gate rule `maxReflow`. Did you mean `maxReflows`?
//            Known rules: maxReflows, maxPerTask, allowReads, allowWrites, ignoreSites.

checkNoReflow(summary, { maxCostMs: 4 });
// TypeError: Rule `maxCostMs` requires the cost lane (v1.2+). This build is 1.1.0.

checkNoReflow(summary, { allowReads: ['offsetWidht'] });
// TypeError: `allowReads` entry `offsetWidht` is not a read this build can emit.
//            Did you mean `offsetWidth`? See the READ_NAMES export.
```

`allowReads` is validated against `READ_NAMES`, the closed vocabulary of reads
this build instruments, derived from the same lists the patcher uses so it
cannot drift. `allowWrites` is a prefix match -- `'CSSStyleDeclaration.'` allows
every style write. `ignoreSites` is a substring match against either call site.

### Expected scopes: `expected()` and `allowExpected`

`allowReads` and `ignoreSites` exclude by identity -- a read name, a call site.
That is too blunt for a deliberate measurement: `allowReads: ['getBoundingClientRect']`
silences the FLIP animation's intentional read AND the accidental read-in-a-loop
three files over. You lose the bug to hide the feature.

The expected-scope lane (v1.5) excludes by **dynamic scope** instead. Wrap the
deliberate measurement in `profiler.expected(fn)`:

```js
profiler.expected(() => {
  const first = el.getBoundingClientRect();   // deliberate FLIP read -- excused
  applyLayoutChange();
  const last = el.getBoundingClientRect();     // excused
  animate(first, last);
});

el.offsetWidth;   // OUTSIDE the scope -- still a violation
```

Reflows inside the callback are stamped `expected: true`. The gate rule
`allowExpected: true` then excuses them -- and *only* them. The same read name
outside the scope still fails. That is the granularity `allowReads` cannot
express: allow the reflow where you meant it, keep failing it everywhere else.

Three properties are worth knowing:

- **The scope is synchronous.** An `await` inside the callback escapes it -- a
  reflow after the await is a new task, not the marked measurement -- matching
  how task epochs and the phase stack already behave. `expected()` nests, and
  restores its depth in a `finally` so a throw cannot strand it.
- **The label is inert until a gate opts in.** Without `allowExpected`, expected
  reflows count like any other, so marking `expected()` regions is safe to leave
  in a dev build regardless of which gates run. `summary().expected` reports the
  count either way, and `summary().records` keeps every expected reflow with its
  flag for audit -- the scope labels, it never suppresses.
- **It is fail-closed.** `allowExpected` on a pre-1.5 summary (records with no
  `expected` flag) is unverifiable, not a silent pass. Exclusions show up in
  `excludedBy.expected`, and a reflow that overlaps `allowExpected` and an
  identity rule is excluded once.

### `ignorePatterns` vs `ignoreSites`

Both filter by call site; they act at different times and the difference
matters when you read a report.

- `ignorePatterns` (profiler option) drops a reflow **at capture time**. It is
  never recorded and never appears in `total`.
- `ignoreSites` (gate rule) excludes an **already-recorded** reflow at gate
  time. It still appears in `total`, and the subtraction is auditable via
  `report.excluded` and `report.excludedBy`.

Prefer `ignoreSites` when you want the number to stay honest and the exclusion
visible. Use `ignorePatterns` only to keep a known-noisy third party out of the
buffer entirely.

> **A sharp edge worth stating plainly.** `ignorePatterns` matches a raw
> substring against the reflow's captured stack. In a real browser every stack
> frame is a file URL -- `at handler (https://host/app/index.html:42:9)` -- so
> a pattern is tested against your own file paths too. A pattern like
> `'index.html'` or `'app'` will match *every* reflow your own code triggers
> and silently drop all of them, leaving the counter at `0` no matter what the
> page does. Target a specific dependency path (`'node_modules/gsap'`), never a
> generic word or your own file's path. (Node/jsdom stacks often omit URLs,
> which is how this mistake hides in a test suite and only surfaces in Chrome.)

## Reporting

`checkNoReflow` returns a report; four formatters turn it into output. Each
takes the raw report and derives the verdict internally, so they work on a fresh
in-browser report and on one round-tripped through `layout.json` alike.

```js
import {
  checkNoReflow, formatConsole, formatJson, formatMarkdown, formatGithubAnnotations
} from '@zakkster/lite-layout-profiler';

const report = checkNoReflow(profiler.summary(), { maxReflows: 0 });

console.log(formatConsole(report));         // [PASS]/[FAIL]/[INCONCLUSIVE] + reasons
const json = formatJson(report);            // the layout.json envelope (below)
const md = formatMarkdown(report);          // a PR-comment table
const gh = formatGithubAnnotations(report); // ::error / ::warning workflow commands
```

The verdict is derived from the report's `ok` and `verified` booleans, which
stay the source of truth:

| ok | verified | verdict |
| --- | --- | --- |
| any | `false` (or absent) | `inconclusive` |
| `false` | `true` | `fail` |
| `true` | `true` | `pass` |

`verified` must be exactly `true` for a definitive verdict -- a run that could
not verify a rule (incomplete coverage, a foreign patch) is never a pass.

`formatJson` produces the `lite-layout-report/1` envelope:

```json
{
  "schema": "lite-layout-report/1",
  "version": "1.6.0",
  "generatedAt": "2026-07-30T00:00:00.000Z",
  "verdict": "fail",
  "report": { "ok": false, "verified": true, "counted": 5, "violations": [ ... ] }
}
```

## CLI: lite-layout-gate

Layout cannot be forced headless in Node, so the CLI does not run the profiler.
Run the profiler in the browser, gate with `checkNoReflow`, write the envelope
to a file, and gate that file in CI:

```js
// in the page, after exercising the UI:
import { checkNoReflow, formatJson } from '@zakkster/lite-layout-profiler';
const json = formatJson(checkNoReflow(profiler.summary(), { maxReflows: 0 }));
// download/emit `json` as layout.json (e.g. Playwright saves it from page context)
```

```sh
# in CI, against the captured file:
npx lite-layout-gate layout.json
npx lite-layout-gate layout.json --format github    # PR annotations
npx lite-layout-gate layout.json --format json --out gated.json
```

Options: `--format console|json|markdown|github` (default console), `--out path`
(also write the JSON envelope), `--allow-inconclusive` (accepted for parity with
`lite-gc-gate`; inconclusive is exit 2 either way).

Exit codes, identical to `lite-gc-gate`:

| code | meaning |
| --- | --- |
| 0 | pass |
| 1 | fail |
| 2 | inconclusive |
| 3 | infrastructure error (file missing, bad JSON, not a report) |

Feeding the CLI a summary rather than a report exits 3 with a redirect: a
summary has no verdict until rules are applied, and applying rules is the
browser's job. There is no `run` subcommand.

## Cost

A count tells you a reflow happened. The cost tells you whether it mattered.

Each forced read is timed across the original getter, so `costMs` is the stall
itself and not the bookkeeping around it:

```js
const s = profiler.summary();

s.cost;
// { resolutionMs: 0.1, measured: 47, unmeasured: 3,
//   totalMs: 62.4, maxMs: 11.2, avgMs: 1.33, p99Ms: 9.8 }

checkNoReflow(s, {
    maxReflows: 50,
    maxCostMs: 4,          // no single reflow may stall over 4 ms
    maxTotalCostMs: 16     // and the run may not spend a frame's worth in total
});
```

Both budgets earn their keep separately: fifty reflows of 0.2 ms is a
different problem from one reflow of 12 ms, and only the second one drops a
frame on its own.

### Null is not zero

Browsers deliberately coarsen `performance.now()` -- a non-isolated Chrome tab
clamps to 100us, Firefox to 1ms by default. A reflow shorter than that reads
back as exactly `0`, which is indistinguishable from free.

So the profiler probes the clock floor once at init and stores it as
`cost.resolutionMs`. A stall that does not clear **more than one tick** is
recorded as `costMs: null` with `belowGranularity: true`. One tick is not a
small measurement, it is an absent one: a delta of exactly one tick means the
true duration lies somewhere in `(0, 2 x tick)`, an interval that contains
zero. Only from two ticks up does the number carry a positive lower bound.

Every aggregate follows the same rule. With nothing measured, `totalMs`,
`maxMs`, `avgMs` and `p99Ms` are `null`, never `0`.

### Cost rules refuse to guess

If any counted reflow carries no cost, `maxCostMs` and `maxTotalCostMs` fail
as unverifiable rather than summing the nulls as zeroes -- otherwise a
thousand sub-resolution stalls would slide under a millisecond budget:

```
cost: 3 of 50 counted reflows carry no cost, having landed below the
0.1 ms timer resolution. Gate on counts instead, or raise the workload
so each stall clears the clock.
```

On a coarse-clocked browser this means cost budgets simply do not apply, and
you gate on `maxReflows` and `maxPerTask` instead. That is the correct
outcome: you cannot pass a budget you were never able to measure.

### Turning it off

`measureCost: false` skips the init probe and the two clock reads per
violation. Every `costMs` becomes `null`, so cost rules become unverifiable
and count rules keep working:

```js
createLayoutProfiler({ captureStacks: false, measureCost: false });
```

That pair is the CI-counting configuration: no stack allocation, no timing,
just the numbers `maxReflows` and `maxPerTask` need.

## Phase

A forced reflow is bad everywhere, but not equally. Inside a
`requestAnimationFrame` callback it stalls the exact frame the browser is
trying to paint -- a guaranteed dropped frame. Inside a `setTimeout` it is bad
but not frame-fatal. The phase lane tells them apart.

```js
const profiler = createLayoutProfiler({ phases: true });   // opt-in

// ... run the interaction ...

assertNoReflow(profiler.summary(), {
    maxReflows: 50,     // some reflows are tolerable while you migrate
    maxInRaf: 0         // but NONE during render
});
```

`{ phases: true }` wraps the schedulers -- `requestAnimationFrame`,
`setTimeout`/`setInterval`, `queueMicrotask`/`Promise.then`, `ResizeObserver`
-- so every reflow is stamped with the phase it fired under:

```js
profiler.summary().phases;
// { raf: 3, timer: 1, microtask: 0, roCallback: 0, event: 0, unknown: 12, unobserved: 0 }
```

### Opt-in, and honest when off

Wrapping the schedulers touches globals every scheduled callback in the page
runs through -- broader than the read/write patching -- so it is off by
default. With it off, every record is phase `unobserved` and `maxInRaf` gates
as **unverifiable**, never a pass: you cannot assert "no reflow in rAF" if you
never watched rAF. `phasesObserved` reports whether `requestAnimationFrame` was
*actually* wrapped, so on a host without rAF (a worker, an old runtime)
`maxInRaf` stays unverifiable rather than falsely green. A reflow that fires
with no wrapped scheduler active is phase `unknown` -- the honest answer, never
guessed into `raf`.

### Thrash collapsing

A getter read in a loop forces one reflow per iteration and would otherwise
produce thousands of near-identical records. The phase lane folds an identical
`(read, write, readSite, writeSite)` tuple repeating within one task into a
single `summary().thrash` group with a `count`:

```js
for (let i = 0; i < 1000; i++) { el.style.width = i + 'px'; void el.offsetWidth; }
// summary().thrash -> [{ read: 'offsetWidth', ..., count: 1000 }]
// summary().records still has all 1000 (the raw view the gate counts)
```

`maxThrash: 1` forbids any read-after-write tuple from repeating within a
block -- the signature of a layout read stuck in a loop. Thrash collapsing does
**not** require `{ phases: true }`; it reads the call sites already recorded.

### ResizeObserver feedback loops

An RO callback that writes layout, dirties, and forces the observer to refire
is a self-perpetuating stall. A reflow inside such a callback is flagged
`roFeedback: true` on its record and thrash group.

## Cross-realm and iframes

By default the profiler instruments the main realm: `Element.prototype`,
`HTMLElement.prototype`, `window`, read from the page's own globals. An iframe
is a *separate realm* with its own copies of those objects, so a reflow forced
through a child frame's element is invisible to a main-realm profiler. `addRealm`
closes that gap.

```js
const profiler = createLayoutProfiler();

// Instrument a same-origin child frame.
const handle = profiler.addRealm(iframe.contentWindow);

// ...exercise the app, including the frame...

// If the frame goes away (navigation, detach), remove just its patches:
handle.remove();

profiler.destroy();   // tears down every realm; the main realm last
```

`addRealm(source)` accepts an iframe's `contentWindow`, or a realm-descriptor
object (`{ Element, HTMLElement, Node, CSSStyleDeclaration, DOMTokenList,
SVGGraphicsElement, window }`, all optional) for tests and exotic hosts. It
returns a handle:

| field | meaning |
| --- | --- |
| `available` | whether the realm was usable and instrumented |
| `reason` | when not: `'unusable_realm'` (cross-origin/garbage) or `'inactive'` (after destroy) |
| `realmIndex` | 1-based index, or -1 when unavailable |
| `remove()` | restore just this realm's patches; idempotent, throw-safe |

`summary().patched.realms` reports how many realms are instrumented (1 = main
only). Coverage AND-s across realms: a hole in any instrumented realm makes the
run incomplete, with the failing target namespaced (`realm:1.read:offsetWidth`).
An unusable realm is never counted and never lowers completeness -- it is a
documented blind spot, not a coverage hole.

**Limits, stated plainly.** Cross-origin frames are unreachable (the platform
throws on `contentWindow` access) and are reported as blind spots. The profiler
does not auto-follow iframe navigation or auto-discover frames -- both would need
listeners and a frame-tree walk a dep-free library cannot own, and silently
patching frames you did not name is not something this tool does. Name each realm
you want watched; a navigated frame is a fresh `addRealm`. The mechanism is
proven against synthetic realms in the test suite; the real-browser end-to-end,
like real layout cost, is only truly proven in a real browser.

## API additions

### `checkNoReflow(summary, rules?)` -> `GateReport`

Evaluate a recorded run against a budget. Never throws on breach; throws
`TypeError` on a malformed rule set.

### `assertNoReflow(summary, rules?)` -> `GateReport`

Same, throwing `ReflowBudgetError` on breach. The error carries `.report` and
`.violations`.

### Cost rules

| Rule | Gates |
| --- | --- |
| `maxCostMs` | worst single measured stall |
| `maxTotalCostMs` | sum of measured stalls |

Both are evaluated after allowlist exclusions, and both fail as unverifiable
if any counted reflow is unmeasured.

### Phase rules

| Rule | Gates | Needs |
| --- | --- | --- |
| `maxInRaf` | forced reflows inside rAF callbacks | `{ phases: true }` + rAF present |
| `maxThrash` | worst collapsed read-after-write count in any task | complete records |

`maxInRaf` counts after allowlist exclusions and is unverifiable when the phase
lane was off. `maxThrash` needs no wrappers but, like every per-record rule,
fails as unverifiable on a truncated run.

### `READ_NAMES`

`readonly string[]` -- every read name this build can emit.

### `LayoutProfiler` additions

| Method / Property | Description |
| --- | --- |
| `summary()` | Now returns a serialisable snapshot: adds `truncated`, `stacks`, `byTask`, `taskCount`, `records` |

### `Violation` additions

| Field | Description |
| --- | --- |
| `taskId` | Epoch of the synchronous block this reflow occurred in |
| `costMs` | Milliseconds spent inside the forced layout, or `null` if unmeasurable |
| `belowGranularity` | True when the stall did not clear the clock's granularity |
| `phase` | Scheduler the reflow fired under: `raf`/`timer`/`microtask`/`ro-callback`/`unknown`/`unobserved` |
| `roFeedback` | True if inside a ResizeObserver callback that had already written |

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `maxStored` | number | 200 | Cap on retained records |
| `maxViolations` | number | 200 | **Deprecated** -- pre-1.1 name for `maxStored`, still honoured |
| `measureCost` | boolean | true | Time each reflow and probe the clock floor at init |
| `clock` | function | `performance.now` | Monotonic ms clock, for hosts without `performance` |
| `phases` | boolean | false | Wrap schedulers to classify each reflow by phase (enables `maxInRaf`) |

> The rename resolves a collision: the old option name meant "a buffer of 200",
> while the gate rule of the same name means "a budget of zero". The gate rule
> is `maxReflows`.


## API

### `createLayoutProfiler(options?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxViolations` | number | 200 | Cap on stored violations |
| `onViolation` | function | null | Called on each forced reflow |
| `captureStacks` | boolean | true | Capture call stacks for attribution |
| `warnToConsole` | boolean | true | Log console.warn per violation |
| `ignorePatterns` | string[] | [] | Stack frame substrings to ignore |

### `LayoutProfiler`

| Method / Property | Description |
|---|---|
| `violations` | Array of recorded violation objects |
| `violationCount` | Total count (may exceed stored if capped) |
| `active` | Whether the profiler is active |
| `destroy()` | Unpatch all prototypes, deactivate |
| `reset()` | Clear violations, keep profiler active |
| `summary()` | Aggregate by read property and write source |

### `Violation`

```ts
{
    id: number;
    read: string;           // 'offsetWidth', 'getBoundingClientRect()', etc.
    write: string;          // 'CSSStyleDeclaration.setProperty()', etc.
    readSite: string;       // parsed call site
    writeSite: string;      // parsed call site
    readStack: string;      // full Error.stack
    writeStack: string;
    timestamp: number;
}
```

## Dev-mode only

This library patches `Element.prototype`, `HTMLElement.prototype`, `Node.prototype`, `CSSStyleDeclaration.prototype`, and `window.getComputedStyle`. It allocates per violation (Error.stack capture). It is NOT zero-GC.

Ship behind a `__DEV__` flag:

```js
if (__DEV__) {
    import('@zakkster/lite-layout-profiler').then(m => m.createLayoutProfiler());
}
```

Or strip from production builds via your bundler's dead-code elimination.

## Stack attribution

`readSite` and `writeSite` are extracted from `Error.stack` at capture time by matching known function names (`markDirty`, `onRead`, `LayoutProfiler`) and skipping them to find the first user-code frame. This works reliably for local dev builds but has one caveat:

**Minified or mangled builds will produce unreadable attribution.** If your staging/dev environment strips function names (Terser, esbuild `--minify-identifiers`), the profiler still detects violations correctly, but `readSite` / `writeSite` will show minified frames like `at a.b (chunk.js:1:12345)`. Run this tool against unminified builds -- or ensure sourcemaps are loaded in DevTools -- for readable attribution.

For CI-style runs where you only need counts and not human-readable sites, set `captureStacks: false`. This also skips the `Error.stack` allocation on every DOM write, which is a real speedup in busy code.

## How it works

1. **Write tracking.** Patched write methods/setters set a `dirty` flag with the write source. A `queueMicrotask` callback clears the flag at the end of the current synchronous block.

2. **Read detection.** Patched layout getters check the `dirty` flag. If set, the read forces a synchronous layout recalculation -- a violation is recorded with both call sites.

3. **Self-clearing.** After a forced reflow, the browser HAS recalculated layout. The flag clears so subsequent reads (without intervening writes) don't double-flag.

4. **Clean unpatch.** `destroy()` restores every patched prototype property to its original descriptor, in reverse order.

## License

MIT (c) Zahary Shinikchiev
