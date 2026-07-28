// L4.5 -- Torture for foreign-patch provenance (v1.4), the coverage lane's
// remaining half. The provenance lane makes a POSITIVE claim ("this target is
// foreign-wrapped") and a coverage claim ("complete"), so the danger is
// symmetric: a false `foreign` is noise that trains users to ignore the lane,
// and a false `complete` is the torn-net-that-looks-whole this lane exists to
// prevent. Axes:
//
//   A -- MUST NOT false-positive: an unbranded pre-existing wrapper, and every
//        pristine host impl, must never be asserted `foreign`.
//   B -- MUST detect: a branded other-instance wrapper is `foreign` and drops
//        `complete`, even buried among clean targets.
//   C -- teardown hygiene: stacked instances unwind LIFO, brands vanish with
//        restored wrappers, and no instance clobbers another.
//   D -- self-consistency of the provenance/coverage accounting.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

const BRAND = Symbol.for('lite-layout-profiler.wrapper');

let win;
let profilers = [];
let pristineSnapshot = null;   // captured once, before any patching ever happens

beforeEach(() => {
    win = new Window();
    globalThis.window = win;
    globalThis.document = win.document;
    globalThis.Node = win.Node;
    globalThis.Element = win.Element;
    globalThis.HTMLElement = win.HTMLElement;
    globalThis.CSSStyleDeclaration = win.CSSStyleDeclaration;
    // happy-dom shares prototype objects across Window instances, so a test
    // that orphans a wrapper would leak a brand into the next test. Capture the
    // truly-pristine descriptors the first time, before anything is patched,
    // and hard-reset to them after every test.
    if (pristineSnapshot === null) pristineSnapshot = snapshotProtos();
    profilers = [];
});
afterEach(() => {
    // LIFO teardown: wrappers stack, so the last to patch is the first to
    // restore, or an inner restore is a no-op and a brand leaks.
    for (let i = profilers.length - 1; i >= 0; i--) {
        try { profilers[i].destroy(); } catch (e) { void e; }
    }
    profilers = [];
    // Hard-reset the shared prototypes to their captured-pristine state, so no
    // orphaned brand from any test (including the deliberate-misuse ones) can
    // reach the next.
    if (pristineSnapshot) restoreProtos(pristineSnapshot);
    delete globalThis.window; delete globalThis.document; delete globalThis.Node;
    delete globalThis.Element; delete globalThis.HTMLElement; delete globalThis.CSSStyleDeclaration;
});

async function start(opts) {
    const { createLayoutProfiler } = await import('../../LayoutProfiler.js');
    const p = createLayoutProfiler(Object.assign({ warnToConsole: false }, opts));
    profilers.push(p);
    return p;
}

// Capture full property descriptors for every prototype target the profiler can
// touch, so a test that deliberately orphans wrappers can hard-reset the shared
// happy-dom prototypes afterward (they persist across Window instances). We
// snapshot BEFORE any patching, then restore, which un-brands whatever leaked.
function protoTargets() {
    const out = [];
    const scan = [
        win.Node && win.Node.prototype,
        win.Element && win.Element.prototype,
        win.HTMLElement && win.HTMLElement.prototype,
        win.CSSStyleDeclaration && win.CSSStyleDeclaration.prototype,
        win.SVGElement && win.SVGElement.prototype
    ];
    for (const proto of scan) {
        if (!proto) continue;
        for (const n of Object.getOwnPropertyNames(proto)) {
            out.push([proto, n]);
        }
    }
    return out;
}
function snapshotProtos() {
    const snap = [];
    for (const [proto, n] of protoTargets()) {
        const d = Object.getOwnPropertyDescriptor(proto, n);
        if (d) snap.push([proto, n, d]);
    }
    return snap;
}
function restoreProtos(snap) {
    for (const [proto, n, d] of snap) {
        try { Object.defineProperty(proto, n, d); } catch (e) { void e; }
    }
}

// =============================================================================
// AXIS A -- MUST NOT false-positive
// =============================================================================

test('[A] an unbranded foreign wrapper on a method is never called foreign', async () => {
    const orig = win.Node.prototype.appendChild;
    win.Node.prototype.appendChild = function () { return orig.apply(this, arguments); };
    const p = await start();
    assert.notEqual(p.summary().patched.provenance['Node.appendChild'], 'foreign',
        'unprovable -> must not assert foreign');
    // restore the manual wrapper after (destroy handles our patch; this is the foreign one)
    win.Node.prototype.appendChild = orig;
});

test('[A] an unbranded foreign getter is never called foreign', async () => {
    const proto = win.HTMLElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, 'offsetWidth');
    if (d && d.get && d.configurable) {
        const origGet = d.get;
        Object.defineProperty(proto, 'offsetWidth', {
            get: function () { return origGet.call(this); },
            configurable: true, enumerable: d.enumerable
        });
        const p = await start();
        assert.notEqual(p.summary().patched.provenance['read:offsetWidth'], 'foreign');
        Object.defineProperty(proto, 'offsetWidth', d);
    }
});

test('[A] a clean host reports zero foreign and an empty provenance', async () => {
    const p = await start();
    const s = p.summary();
    assert.equal(s.patched.foreign, 0);
    assert.deepEqual(s.patched.provenance, {});
    assert.equal(s.patched.complete, true);
});

test('[A] a function branded with a DIFFERENT symbol is not our foreign', async () => {
    // Someone else's brand under a different registered symbol is not the
    // lite-layout-profiler brand, so it is unbranded to us -> not asserted foreign.
    const orig = win.Node.prototype.appendChild;
    const other = function () { return orig.apply(this, arguments); };
    Object.defineProperty(other, Symbol.for('some.other.tool'), { value: 'x' });
    win.Node.prototype.appendChild = other;
    const p = await start();
    assert.notEqual(p.summary().patched.provenance['Node.appendChild'], 'foreign');
    win.Node.prototype.appendChild = orig;
});

// =============================================================================
// AXIS B -- MUST detect a branded other-instance wrapper
// =============================================================================

test('[B] a second instance detects the first as foreign and drops complete', async () => {
    await start();                     // first
    const second = await start();      // patches on top
    const s = second.summary();
    assert.ok(s.patched.foreign > 0);
    assert.equal(s.patched.complete, false);
});

test('[B] a wrapper carrying OUR brand from another instance is detected', async () => {
    // Simulate a leaked prior run: brand a wrapper as if a DIFFERENT instance
    // installed it, then start. The brand is our registered symbol but a
    // different id string, so classifyExisting must return foreign.
    const orig = win.Node.prototype.appendChild;
    const leaked = function () { return orig.apply(this, arguments); };
    Object.defineProperty(leaked, BRAND, { value: 'llp-someotherid', enumerable: false, configurable: true });
    win.Node.prototype.appendChild = leaked;

    const p = await start();
    assert.equal(p.summary().patched.provenance['Node.appendChild'], 'foreign',
        'a foreign lite-layout-profiler brand is a hard, verified fact');
    assert.ok(p.summary().patched.foreign >= 1);
    win.Node.prototype.appendChild = orig;
});

test('[B] one foreign target among many clean ones still drops complete', async () => {
    const orig = win.Node.prototype.appendChild;
    const leaked = function () { return orig.apply(this, arguments); };
    Object.defineProperty(leaked, BRAND, { value: 'llp-elsewhere', enumerable: false, configurable: true });
    win.Node.prototype.appendChild = leaked;

    const p = await start();
    const s = p.summary();
    assert.equal(s.patched.complete, false, 'a single foreign target is enough to make coverage incomplete');
    assert.equal(s.patched.foreign, 1, 'exactly the one branded target');
    win.Node.prototype.appendChild = orig;
});

test('[B] our OWN brand from the SAME logical run is not foreign (re-entrant)', async () => {
    // A wrapper carrying THIS instance's brand would be owned-reentrant, not
    // foreign. We cannot easily get the live id, but we can assert the inverse:
    // a fresh single instance never reports itself foreign.
    const p = await start();
    assert.equal(p.summary().patched.foreign, 0);
});

// =============================================================================
// AXIS C -- teardown hygiene
// =============================================================================

test('[C] stacked instances unwind LIFO leaving the prototype as found', async () => {
    const proto = win.Node.prototype;
    const pristineAppend = proto.appendChild;
    const a = await start();
    const b = await start();
    const c = await start();
    // Unwind last-first.
    c.destroy(); b.destroy(); a.destroy();
    profilers = [];
    assert.equal(proto.appendChild, pristineAppend,
        'after LIFO teardown the slot holds the pristine impl again');
    // And no brand lingers.
    assert.equal(proto.appendChild[BRAND], undefined, 'no brand residue on the restored impl');
});

test('[C] destroying an inner instance first is a no-op that does not corrupt', async () => {
    const proto = win.Node.prototype;
    // Snapshot the pristine state BEFORE any patching, so we can hard-reset
    // after deliberately creating an orphaned-wrapper situation. (happy-dom
    // shares prototypes across Windows, so residue would leak into later tests.)
    const snap = snapshotProtos();

    const a = await start();
    const b = await start();   // b wraps on top of a
    // Destroy a (inner) FIRST -- identity check means it cannot restore, since
    // b's wrapper sits in the slot. This must not throw or corrupt.
    a.destroy();
    // b still runs; destroying it restores to a's wrapper (now orphaned).
    b.destroy();
    profilers = [];
    // The slot is NOT pristine here (that is the whole point of LIFO), but it
    // must be a usable function and not throw.
    assert.equal(typeof proto.appendChild, 'function');
    // Hard-reset every prototype target so orphaned brands do not leak into the
    // next test through the shared happy-dom prototype objects.
    restoreProtos(snap);
});

test('[C] a fresh instance after clean LIFO teardown is clean', async () => {
    const a = await start();
    const b = await start();
    b.destroy(); a.destroy();
    profilers = [];
    const fresh = await start();
    assert.equal(fresh.summary().patched.foreign, 0);
    assert.equal(fresh.summary().patched.complete, true);
});

test('[C] destroy is idempotent under provenance tracking', async () => {
    const p = await start();
    p.destroy();
    assert.doesNotThrow(() => p.destroy(), 'double destroy must not throw');
    profilers = [];
});

// =============================================================================
// AXIS D -- self-consistency
// =============================================================================

test('[D] foreign count equals the number of foreign provenance entries', async () => {
    await start();
    const second = await start();
    const s = second.summary();
    const foreignEntries = Object.values(s.patched.provenance).filter((v) => v === 'foreign').length;
    assert.equal(s.patched.foreign, foreignEntries,
        'the count and the map must agree');
});

test('[D] applied includes foreign targets (we still instrument them)', async () => {
    await start();
    const second = await start();
    const s = second.summary();
    // A foreign target is still applied (we wrapped on top and detect reflows).
    assert.ok(s.patched.applied >= s.patched.foreign,
        'every foreign target is also counted applied');
});

test('[D] complete is true iff failed and foreign are both zero', async () => {
    const clean = await start();
    const sc = clean.summary();
    assert.equal(sc.patched.complete, (sc.patched.failed === 0 && sc.patched.foreign === 0));

    const second = await start();
    const s2 = second.summary();
    assert.equal(s2.patched.complete, (s2.patched.failed === 0 && s2.patched.foreign === 0));
});

test('[D] provenance never lists a clean (owned) target', async () => {
    await start();
    const second = await start();
    const s = second.summary();
    // Every listed target is non-clean: foreign or unknown, never a bare owned.
    for (const [, v] of Object.entries(s.patched.provenance)) {
        assert.ok(v === 'foreign' || v === 'unknown', 'only non-clean states are listed: ' + v);
    }
});

test('[D] provenance is a fresh object each summary call, not a live reference', async () => {
    await start();
    const second = await start();
    const s1 = second.summary();
    const s2 = second.summary();
    assert.notEqual(s1.patched.provenance, s2.patched.provenance,
        'each snapshot is its own object, safe to mutate or serialise');
    assert.deepEqual(s1.patched.provenance, s2.patched.provenance, 'but equal in content');
});
