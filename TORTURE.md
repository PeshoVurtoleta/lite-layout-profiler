# @zakkster/lite-layout-profiler -- Torture Test Plan

**Status:** 192 torture scenarios shipped across v1.2.0, v1.3.0, v1.4.0,
v1.5.0, v1.6.0, and v1.7.0 (slots L1.5, L2.5, L3.5, L99.9, L4.5, L4.6, L5.5,
L6.5, L7.5). Axes A-I from v1.2, J-L added in v1.6 for the reporting layer and
CLI, M-P added in v1.7 for the cross-realm lane; the phase lane (L4.5) reuses
A-E, the provenance lane (L4.6) reuses A-D, and the expected-scope lane (L5.5)
reuses A-D, with lane-specific meanings. v1.2's
suite found 22 defects on first run; v1.3's L4.5 found 1 (`phasesObserved`
reporting intent rather than whether rAF actually wrapped); v1.4's L4.6 surfaced
the LIFO-teardown requirement for stacked instances. All fixed before release.

Companion to the roadmap. The L-numbers slot into the lane they torture,
so the adversarial code lands in the same session as the subsystem and
review happens once.

Directory layout: `test/torture/` holds one file per slot plus
`harness.mjs`. The harness is not named `*.test.mjs`, so the runner does
not execute it directly.

---

## Pass criteria

Nine axes. A-D mirror lite-gc-profiler's, because both libraries make the
same promise about verdicts. E-I are specific to this one, and they exist
because of a difference worth stating plainly:

> **lite-gc-profiler observes its host. lite-layout-profiler modifies it.**

A GC profiler that malfunctions returns a bad number. A prototype patcher
that malfunctions leaves a permanently slower page behind, or silently
stops detecting anything while continuing to report zeroes. That is a
different and larger blast radius, and it needs its own axes.

**Axis A -- adversarial input that MUST come back unverified.** Never
`ok`. A green verdict here is the worst bug this package can have: the
gate claimed to have checked something it could not see. Ranks above
every other correctness concern.

**Axis B -- real signal buried in noise that MUST fail.** The gate cannot
be drowned by volume, by clean adjacent tasks, or by an allowlist that
excludes almost everything.

**Axis C -- clean signal under hostile conditions that MUST pass.** The
gate cannot be flaky against the machine, or a team learns to ignore it.

**Axis D -- self-consistency across the API.** `checkNoReflow`,
`assertNoReflow` and `summary()` must agree wherever their scopes
overlap, and none of them may mutate their input.

**Axis E -- teardown restores the host exactly.** Descriptor identity,
not merely descriptor shape. A profiler that leaves a wrapper behind has
permanently taxed the page it was meant to diagnose.

**Axis F -- hostile hosts.** Frozen prototypes, non-configurable
descriptors, absent globals, accessors that throw, foreign instrumenters
above and below us. A torn patch net must never look like a clean run.

**Axis G -- clock pathology.** The cost lane trusts one thing about its
environment: that a clock returns increasing numbers. Nothing enforces
that. A clock that cannot be trusted must produce no measurement, never a
wrong one.

**Axis H -- capacity and retention.** The ring is the only unbounded
thing a long-running page hands this library. Every boundary around it is
a place where a silent wrong answer is cheaper to produce than a right
one.

**Axis I -- reentrancy.** `onViolation` fires synchronously, inside the
offending task. Anything the callback does -- read, write, throw,
destroy, reset -- happens in the middle of the profiler's own
bookkeeping.

**Axis J -- a formatter never lies (v1.6).** No report, however malformed,
may crash a formatter or upgrade a non-pass to a PASS. A missing `verified`
flag, a non-array `violations`, a null report -- each must render as
inconclusive-or-worse, never green.

**Axis K -- the envelope is faithful (v1.6).** What `formatJson` wraps comes
back out: the raw report byte-for-byte in structure, the verdict re-derivable
from the round-tripped report, across every verdict.

**Axis L -- the CLI's exit code matches its printed verdict (v1.6).** 0/1/2
track pass/fail/inconclusive exactly, and an unreadable input is always exit 3,
never a silent 0.

**Axis M -- a second realm's reflow is caught iff its realm is added (v1.7).**
A write-then-read through an added realm's element is recorded in the same
unified summary; the same pattern before the realm is added is invisible.

**Axis N -- realm teardown restores exactly (v1.7).** `handle.remove()` restores
only its realm and leaves the others recording; removal works in any order; it
is idempotent and throw-safe when the realm's prototypes are already gone (an
iframe navigated away); `destroy()` tears down every realm.

**Axis O -- unusable realms degrade, never throw (v1.7).** A cross-origin
`contentWindow` (property access throws), a scalar, an empty object -- each
yields an unavailable handle, never a throw, and never lowers main-realm
completeness.

**Axis P -- per-realm coverage and provenance (v1.7).** A partly-patchable
second realm records its holes namespaced (`realm:1.read:offsetWidth`), and
`complete` AND-s across realms: a hole anywhere makes the run incomplete, while a
clean realm changes nothing.

---

## SHIPPED

### L1.5 -- Patch integrity and hostile hosts (v1.2.0)

`test/torture/l1-5-patching.test.mjs` -- 21 scenarios. Axes E (8), F (13).

Descriptor-identity snapshots before and after, repeated patch/destroy
cycles, idempotent destroy, nested and out-of-order teardown, frozen and
non-configurable prototypes, every optional global omitted in turn,
throwing getters and setters, foreign patches above and below ours, a
prototype chain swapped mid-run.

### L2.5 -- Gate adversarial (v1.2.0)

`test/torture/l2-5-gate-adversarial.test.mjs` -- 43 scenarios.
Axes A (13), B (6), C (6), D (6), plus 12 rule-set hostility cases.

Truncated and absent record sets, records that are not arrays, records
containing nulls, records missing the fields a rule reads, totals that
are not counts, totals inconsistent with their own records, NaN and
infinite and negative costs, a thousand sub-resolution stalls under a
1 ms budget, prototype-polluting rule keys, null-prototype and inherited
rule objects, symbol keys, absurdly long key names against the
did-you-mean search.

### L3.5 -- Clock pathology and cost recording (v1.2.0)

`test/torture/l3-5-cost-clock.test.mjs` -- 16 scenarios. Axis G (10),
plus 6 cost-accounting invariants.

Frozen, backwards, NaN, infinite, string-returning, throwing and
jittering clocks. Aggregate consistency (`total >= max >= avg`,
`p99 <= max`, sum equals total), the one-tick boundary, percentiles at
1/2/3/99/100/101 samples, null survival across JSON.

### L99.9 -- Extreme (v1.2.0)

`test/torture/l99-9-extreme.test.mjs` -- 25 scenarios. Axes H (12),
I (13).

Every invalid storage cap, retention at cap-1/cap/cap+1, a hundred ring
wraps, reset at every ring phase, a hundred thousand reflows, callbacks
that read, write, throw, destroy, reset, summarise and gate from inside
`onViolation`.

### L4.5 -- Phase lane and thrash collapsing (v1.3.0)

`test/torture/l4-5-phase.test.mjs` -- 26 scenarios. Axes A (6), B (5),
C (4), D (6), E (5).

The phase lane reuses the v1.2 axes with lane-specific meaning. A is the
critical one: `maxInRaf` MUST be unverifiable on a run recorded without
`{ phases: true }`, on a truncated run, on a pre-1.3 summary, and when
`phasesObserved` is anything but strictly `true` -- claiming "no reflow in
rAF" without having wrapped rAF is the phase analogue of certifying
through a torn net. E is specific to this lane: the scheduler wrappers
touch globals the whole page shares, so teardown must restore every one by
identity (never deleting a foreign shim layered on top), a host with no
schedulers must not throw under `{ phases: true }`, a throwing scheduled
callback must not strand the phase stack, and `{ phases: false }` must
leave every scheduler untouched.

**The one defect L4.5 found:** `phasesObserved` reported the *intent*
(`phases: true`) rather than whether `requestAnimationFrame` was actually
wrapped. On a host without rAF -- a worker, an old runtime -- that made
`maxInRaf` falsely verifiable: it would have returned a clean pass for a
budget it could not actually check. Fixed to report the real wrap result,
so `maxInRaf` stays unverifiable exactly when rAF was not watched.

### L4.6 -- Foreign-patch provenance (v1.4.0)

`test/torture/l4-6-provenance.test.mjs` -- 17 scenarios. Axes A (4), B (4),
C (4), D (5).

The provenance lane makes a positive claim ("this target is foreign-wrapped")
and a coverage claim ("complete"), so the danger is symmetric and the axes guard
both directions. Axis A is the false-positive guard, and it is the load-bearing
one: an unbranded foreign wrapper on a method, an unbranded foreign getter, a
function branded under a *different* tool's symbol, and every pristine host impl
must NEVER be asserted `foreign`. Claiming foreign on an unprovable target is the
noise that trains users to ignore a coverage lane, and because happy-dom impls
carry no `[native code]` marker, a naive nativeness heuristic would fire on all
of them. Axis B proves the flip side: a wrapper carrying another instance's
brand IS detected with certainty, drops `complete`, and does so even as the only
foreign target among many clean ones. Axis C is teardown hygiene -- stacked
instances unwind LIFO leaving the prototype as found, an inner-first destroy is a
survivable no-op, and destroy is idempotent. Axis D is accounting
self-consistency: `foreign` equals the count of foreign provenance entries,
foreign targets are still counted `applied`, `complete` is true iff `failed` and
`foreign` are both zero, and each summary's provenance is a fresh object.

**What L4.6 surfaced:** stacked profiler instances must be destroyed
last-in-first-out. Because wrappers stack and the restore is identity-checked, an
inner instance destroyed before an outer one cannot restore (the slot holds the
outer wrapper) and leaves an orphaned, still-branded wrapper. In happy-dom, whose
prototype objects are shared across `Window` instances, that orphan leaked a
brand into the next test until the harness both tore down LIFO and hard-reset to
a captured-pristine snapshot. The library behaves correctly; the requirement is
on the caller, and it is now documented.

---

## Defects found on first run

The suite was written against v1.2.0 as it stood after the cost lane, and
run before any of it was known to fail. Twenty-two scenarios came back
red. None of these were hypothetical; each is a way the tool could have
reported a confident wrong answer.

**Silent falsification (axis A and F)**

1. `NaN` cost counted as a measurement. `typeof NaN === 'number'`, and
   NaN compares false against every limit, so a corrupted report passed
   any cost budget in silence. Now `isMeasuredCost` requires finite and
   non-negative.
2. `Infinity` and negative costs likewise.
3. A frozen prototype **crashed the constructor**, so the recommended
   response was to not use the tool on hardened pages.
4. Non-configurable descriptors also crashed: `patchGetter` checked for
   a getter but not for configurability, while `patchWindowMetrics`
   checked both. The inconsistency was the bug.
5. No coverage tracking at all. A host that refused half the patch net
   produced zero reflows and a green gate, indistinguishable from a
   clean page. `summary().patched` and the `patched` gate check exist
   because of this.
6. Malformed records (nulls, missing fields) crashed the exclusion pass
   rather than being refused.
7. A non-numeric `summary.total` silently became `0`, turning a
   corrupted report into a clean bill of health.
8. A summary carrying more records than its own `total` was gated
   anyway.

**Rule-set integrity**

9. Rule values were read through the prototype chain while validation
   walked own keys only, so `Object.create({ maxReflows: -5 })` applied
   an unvalidated negative limit.
10. Exclusions could drive `counted` below zero.

**Host corruption (axis E)**

11. Teardown wrote saved originals back unconditionally, **deleting any
    foreign patch installed after ours**. Restores are now
    identity-checked: the profiler declines to unpatch what it no longer
    owns.
12. `destroy()` threw on a host frozen after patching, abandoning the
    remaining restores.
13. Out-of-order teardown of nested profilers left 31 stale wrappers on
    the host permanently. Now bounded by the identity check; the
    residual is pinned by a test as documented behaviour rather than
    silently drifting.

**Reentrancy (axis I)**

14. **A callback that read a layout property recursed without bound.**
    The dirty flag was cleared *after* `onViolation`, so the callback's
    own read was itself a violation, which fired the callback again. A
    debug overlay reading `offsetWidth` was enough to blow the stack.
    The flag is now cleared before any user code runs.
15. A callback that threw stranded the dirty flag, turning every later
    read in the task into a phantom violation. Same fix.
16. A non-function `onViolation` was called anyway.

**Capacity (axis H)**

17. `maxStored: 0` silently became 200 via a `||` chain.
18. `maxStored: 1.5` threw `RangeError` from `new Array()`.
19. `maxStored: Infinity` likewise.
20. `maxStored: NaN` silently became 200.
21. `maxStored: 2**32` bought a dictionary-mode array.
    17-21 are now one validation: an integer in `1..1000000`, or a
    `TypeError` naming the option.
22. `reset()` walked the whole capacity rather than the occupied slots,
    so a large cap made clearing an empty ring expensive.

**Also corrected: three wrong test expectations of mine.** Out-of-order
teardown, `maxReflows` on a truncated run, and an overlay write inside
`onViolation`. The third is worth naming: a callback that writes to the
DOM *genuinely* dirties layout, and the next read genuinely stalls. The
profiler was reporting the truth and my test was demanding a lie. That
scenario is now pinned in both directions -- the honest report, and
`ignorePatterns` as the remedy.

---

### L5.5 -- Expected-scope lane (v1.5.0)

`test/torture/l5-5-expected.test.mjs` -- 18 scenarios. Axes A (5), B (4),
C (5), D (4).

The lane makes a scoped exclusion possible, so its danger is symmetric with the
allowlist: a reflow must be excused ONLY where deliberate (a false exclusion
hides a real bug) and the scope must be exactly the synchronous region marked (a
leaked scope excuses reflows the developer never meant). Axis A pins the
boundaries: a reflow immediately before or after `expected()` is not expected, a
throw does not leak the scope to later reflows, a nested throw unwinds only one
level, an `await` inside the callback escapes (the post-await reflow is a new
task), and a pure `expected()` records nothing. Axis B proves the exclusion is
scoped and not identity: the same read name is excused in-scope and fails
out-of-scope, a reflow overlapping `allowExpected` and `allowReads` is excluded
exactly once, and an out-of-scope reflow matching nothing is not excused. Axis C
is fail-closed: `allowExpected` without the record flag is unverifiable, the
label is inert without the rule, `allowExpected: false` equals omitting it, a
non-boolean throws, and `expected(fn)` rejects non-functions. Axis D is
accounting: deep nesting stays expected and unwinds cleanly, `summary().expected`
equals the count of expected records, `counted + excluded === total`, and reset
clears the count.

The lesson this lane encodes: `allowReads` silences a read everywhere, which
loses a bug to hide a feature; the expected scope is strictly finer because it
excludes by where control was, not by what was read. The torture exists to prove
that "where control was" is exactly the synchronous callback and not one
instruction more -- which is why half of axis A is about throws and awaits, the
two ways a scope could leak.

---

### L6.5 -- Reporting layer and CLI (v1.6.0)

`test/torture/l6-5-report-cli.test.mjs` -- 12 scenarios. Axes J (5), K (3),
L (4).

The formatters and the gate CLI sit between a report and a human or a CI exit
code, so their failure mode is a lie: a malformed report that renders as a clean
PASS, an envelope that drops the verdict on round-trip, a CLI that exits 0 on
something it could not read. Axis J attacks the formatters with reports missing
every field, null/undefined, non-array violations, and a broken `verified` flag
(each of undefined/null/0/''/'true'/NaN must not become a pass); it also asserts
malformed violation entries render without throwing. Axis K round-trips every
verdict through `formatJson` and asserts the raw report survives deep-equal and
the verdict re-derives. Axis L spawns the real CLI and asserts the printed
verdict and exit code never disagree, that garbage/missing/array/scalar inputs
are all exit 3, that a report with absent booleans is not silently accepted, and
that `--format github` on a fail still exits 1.

This slot caught a fail-closed gap during development: `_verdictOf` originally
treated only `verified === false` as inconclusive, so a report with `verified`
absent fell through to a PASS. Axis J's broken-flag scenario failed, and the fix
went to the code -- `verified` must now be exactly `true` for a definitive
verdict -- not the test.

---

### L7.5 -- Cross-realm / iframe lane (v1.7.0)

`test/torture/l7-5-realm.test.mjs` -- 13 scenarios. Axes M (3), N (4), O (3),
P (3).

This lane makes the profiler patch objects it does not own in a SECOND realm and
hand back one unified summary, so its failure modes are a missed cross-realm
reflow, a teardown that strands a foreign prototype, an unusable realm that
throws instead of degrading, and a coverage number that lies about a frame it
could only partly patch. Realms are SYNTHETIC (fresh prototype objects) because
happy-dom shares prototypes across Windows; the machinery is what is under test,
and the real-browser end-to-end is a documented boundary, the same posture the
cost lane takes.

Axis M records a write-then-read through a second realm's element -- invisible
before `addRealm`, caught after, and two realms feeding one total. Axis N
removes realms in and out of order, proves `remove()` restores only its own
realm while the others keep recording, and is idempotent and throw-safe when the
realm's prototype has been replaced under it (a navigated frame); `destroy()`
restores every realm. Axis O throws nine kinds of garbage and a
property-access-throwing Proxy (a cross-origin `contentWindow`) at `addRealm` and
asserts each degrades to an unavailable handle without throwing or lowering
completeness. Axis P adds a realm whose `offsetWidth` is non-configurable (a real
hole), and asserts the failure is namespaced `realm:1.*`, that `complete` flips
to false (AND-ed across realms), and that a clean realm leaves completeness
untouched.

---

## Not in scope

- **Real browser layout.** The stub DOM cannot force real layout, so
  cost figures here are driven by an injected clock. Torture proves the
  accounting; only a real engine proves the measurement.
- **Real browser cross-realm end-to-end.** The cross-realm lane (L7.5,
  v1.7) is proven against SYNTHETIC realms, because happy-dom shares
  prototypes across Windows and cannot model true realm separation. The
  machinery -- patching, per-realm teardown, namespaced coverage -- is
  covered; the real-browser iframe end-to-end, like real layout cost,
  is only truly proven in a real browser.
- **Concurrency.** There are no threads in a document context, and the
  worker case has no DOM.

## Planned

- **ReflowForge viewer (v2.0).** A browser viewer for a serialised
  `lite-layout-report/1`, the layout analogue of GCForge. Reads the
  envelope `formatJson` produces and renders the counted/excluded
  tallies, the per-violation reasons, and per-realm coverage. Report-only,
  like GCForge; no schema it does not already receive.
