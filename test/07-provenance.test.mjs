// Foreign-patch provenance / coverage lane (v1.4). At instrument time a target
// already wrapped by ANOTHER lite-layout-profiler instance is detected via its
// brand and reported `foreign`, so summary().patched stops claiming complete
// coverage it does not have. The honest limit: an UNBRANDED pre-existing
// wrapper cannot be told apart from a pristine host impl, so it is never
// falsely called foreign. Adversarial cases in test/torture/l4-5-provenance.test.mjs.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

let win;
let profilers = [];

beforeEach(() => {
    win = new Window();
    globalThis.window = win;
    globalThis.document = win.document;
    globalThis.Node = win.Node;
    globalThis.Element = win.Element;
    globalThis.HTMLElement = win.HTMLElement;
    globalThis.CSSStyleDeclaration = win.CSSStyleDeclaration;
    profilers = [];
});
afterEach(() => {
    // Destroy in REVERSE order: wrappers stack, so the last instance to patch
    // must be the first to restore, or an inner instance's restore is a no-op
    // (the slot holds an outer wrapper) and a brand leaks onto the shared
    // happy-dom prototype into the next test.
    for (let i = profilers.length - 1; i >= 0; i--) {
        try { profilers[i].destroy(); } catch (e) { void e; }
    }
    profilers = [];
    delete globalThis.window; delete globalThis.document; delete globalThis.Node;
    delete globalThis.Element; delete globalThis.HTMLElement; delete globalThis.CSSStyleDeclaration;
});

async function start(opts) {
    const { createLayoutProfiler } = await import('../LayoutProfiler.js');
    const p = createLayoutProfiler(Object.assign({ warnToConsole: false }, opts));
    profilers.push(p);
    return p;
}

// ---------------------------------------------------------------------------
// clean start
// ---------------------------------------------------------------------------

test('a clean start reports no foreign patches and complete coverage', async () => {
    const p = await start();
    const s = p.summary();
    assert.equal(s.patched.foreign, 0);
    assert.equal(s.patched.complete, true);
    assert.deepEqual(s.patched.provenance, {}, 'no non-clean targets to list');
});

test('the patched summary carries the new v1.4 fields', async () => {
    const p = await start();
    const s = p.summary();
    assert.equal(typeof s.patched.foreign, 'number');
    assert.equal(typeof s.patched.provenance, 'object');
});

// ---------------------------------------------------------------------------
// a second instance detects the first's brand
// ---------------------------------------------------------------------------

test('a second profiler instance detects the first as foreign', async () => {
    const first = await start();
    const second = await start();      // patches on top of first's wrappers
    const s = second.summary();
    assert.ok(s.patched.foreign > 0, 'the second instance sees the first everywhere it patched');
    assert.equal(s.patched.complete, false, 'foreign patches make coverage incomplete');
});

test('foreign targets are named in provenance', async () => {
    const first = await start();
    const second = await start();
    const s = second.summary();
    const entries = Object.entries(s.patched.provenance);
    assert.ok(entries.length > 0);
    assert.ok(entries.every(([, v]) => v === 'foreign'),
        'every listed target is the verified foreign state');
});

test('the first instance, patched before anyone, stays clean', async () => {
    const first = await start();
    // The first sees pristine host impls, not our brand.
    assert.equal(first.summary().patched.foreign, 0);
    assert.equal(first.summary().patched.complete, true);
});

// ---------------------------------------------------------------------------
// the honest limit: unbranded foreign is NOT falsely flagged
// ---------------------------------------------------------------------------

test('an unbranded foreign wrapper is not falsely called foreign', async () => {
    // A framework hook with no lite-layout-profiler brand. We cannot tell it
    // apart from a pristine host JS impl (measured: happy-dom impls have no
    // [native code] marker), so we must NOT claim foreign -- a false positive
    // on every pristine getter is exactly the noise this lane must avoid.
    const origAppend = win.Node.prototype.appendChild;
    win.Node.prototype.appendChild = function () { return origAppend.apply(this, arguments); };

    const p = await start();
    const s = p.summary();
    assert.notEqual(s.patched.provenance['Node.appendChild'], 'foreign',
        'an unbranded wrapper must never be asserted foreign');
});

test('pristine host getters are never reported foreign', async () => {
    const p = await start();
    const s = p.summary();
    for (const [, v] of Object.entries(s.patched.provenance)) {
        assert.notEqual(v, 'foreign', 'a clean host has no foreign targets');
    }
});

// ---------------------------------------------------------------------------
// teardown restores cleanliness (brands vanish with wrappers)
// ---------------------------------------------------------------------------

test('after teardown a fresh instance is clean again', async () => {
    const first = await start();
    const second = await start();
    assert.ok(second.summary().patched.foreign > 0);
    second.destroy();
    first.destroy();
    profilers = [];

    const fresh = await start();
    assert.equal(fresh.summary().patched.foreign, 0, 'brands vanished with the restored wrappers');
    assert.equal(fresh.summary().patched.complete, true);
});

test('destroy does not clobber a second instance still running', async () => {
    const first = await start();
    const second = await start();
    // Destroying the first must not delete the second's wrappers (identity check).
    first.destroy();
    // The second is still active and can still summarise.
    assert.doesNotThrow(() => second.summary());
    assert.equal(second.active, true);
});

// ---------------------------------------------------------------------------
// serialisation
// ---------------------------------------------------------------------------

test('provenance round-trips through JSON', async () => {
    const first = await start();
    const second = await start();
    const wire = JSON.parse(JSON.stringify(second.summary()));
    assert.equal(typeof wire.patched.foreign, 'number');
    assert.equal(typeof wire.patched.provenance, 'object');
    assert.equal(wire.patched.complete, false);
});

test('the brand is non-enumerable and does not leak into serialisation', async () => {
    const p = await start();
    // The wrapper functions carry a Symbol.for brand; symbols never appear in
    // JSON, and the property is non-enumerable, so nothing leaks.
    const wire = JSON.stringify(p.summary());
    assert.doesNotMatch(wire, /lite-layout-profiler\.wrapper/,
        'the brand symbol never serialises');
});
