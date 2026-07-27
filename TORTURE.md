# @zakkster/lite-layout-profiler -- Torture Test Plan

**Status:** 131 torture scenarios shipped across v1.2.0 and v1.3.0 (slots
L1.5, L2.5, L3.5, L99.9, L4.5). Axes A-I from v1.2; the phase lane reuses
A-E with lane-specific meanings. v1.2's suite found 22 defects on first
run; v1.3's L4.5 found 1 (`phasesObserved` reporting intent rather than
whether rAF actually wrapped). All fixed before release.

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

## Not in scope

- **Real browser layout.** The stub DOM cannot force real layout, so
  cost figures here are driven by an injected clock. Torture proves the
  accounting; only a real engine proves the measurement.
- **Cross-realm and iframe patching.** Arrives with the realm lane
  (v1.7); its torture slot is L7.5.
- **Foreign-patch provenance.** The identity-checked restore lands here,
  but reporting *which* targets carry a foreign patch is the coverage
  lane's remaining half (v1.4), slot L4.5.
- **Concurrency.** There are no threads in a document context, and the
  worker case has no DOM.

## Planned

- **L4.5 -- coverage and provenance (v1.4).** Foreign-patch detection at
  init, per-target provenance, and the `unverified` path when another
  instrumenter owns a target we need.
- **L7.5 -- cross-realm (v1.7).** Realm teardown ordering, an iframe
  navigated mid-run, a document adopted between realms.
