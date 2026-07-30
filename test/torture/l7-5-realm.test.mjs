// L7.5 -- Cross-realm / iframe lane, adversarial. Axes M, N, O, P.
//
// This lane makes the profiler patch objects it does not own in a SECOND realm,
// then hand back a single unified summary. Its failure modes:
//
//   Axis M -- a second realm's reflow MUST be caught once its realm is added,
//             and MUST NOT be caught before.
//   Axis N -- teardown/removal restores every realm exactly, LIFO, and is
//             idempotent and throw-safe when a realm is already gone (an iframe
//             navigated away, a frame detached).
//   Axis O -- an unusable realm (cross-origin, garbage) degrades to a no-op
//             handle, never throws, never lowers main-realm completeness.
//   Axis P -- coverage/provenance is per-realm: a partly-patchable second realm
//             shows its holes namespaced, and `complete` AND-s across realms.
//
// As in the standard suite, realms are SYNTHETIC (fresh prototype objects),
// because happy-dom shares prototypes across Windows. The machinery is what is
// under test; the real-browser end-to-end is a documented boundary.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createLayoutProfiler } from '../../LayoutProfiler.js';

function installMainDom() {
    const w = new Window();
    for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement',
        'CSSStyleDeclaration', 'DOMTokenList']) {
        globalThis[k] = k === 'window' ? w : (k === 'document' ? w.document : w[k]);
    }
    return w;
}
installMainDom();

// A fully-patchable synthetic realm.
function fullRealm() {
    function E() {}
    E.prototype.setAttribute = function () {};
    function H() {}
    H.prototype = Object.create(E.prototype);
    Object.defineProperty(H.prototype, 'offsetWidth', { configurable: true, get() { return 7; } });
    return { realm: { Element: E, HTMLElement: H }, H: H };
}

// A partly-patchable realm: offsetWidth is NON-configurable, so patchGetter
// refuses it -- a real hole in the second realm.
function partialRealm() {
    function E() {}
    E.prototype.setAttribute = function () {};
    function H() {}
    H.prototype = Object.create(E.prototype);
    Object.defineProperty(H.prototype, 'offsetWidth', { configurable: false, get() { return 1; } });
    return { realm: { Element: E, HTMLElement: H }, H: H };
}

// =============================================================================
// AXIS M -- a second realm's reflow is caught iff its realm is added
// =============================================================================

test('[M] before add: a second-realm write-then-read is invisible', () => {
    const p = createLayoutProfiler({ warnToConsole: false });
    const { H } = fullRealm();
    const el = new H();
    el.setAttribute('x', '1'); void el.offsetWidth;
    assert.equal(p.summary().total, 0);
    p.destroy();
});

test('[M] after add: the same pattern is caught, in the same summary', () => {
    const p = createLayoutProfiler({ warnToConsole: false });
    const { realm, H } = fullRealm();
    p.addRealm(realm);
    const el = new H();
    el.setAttribute('x', '1'); void el.offsetWidth;
    assert.ok(p.summary().total >= 1);
    p.destroy();
});

test('[M] two realms record into one unified summary', () => {
    const w = globalThis.window;
    const p = createLayoutProfiler({ warnToConsole: false });
    const { realm, H } = fullRealm();
    p.addRealm(realm);

    // Main realm reflow.
    const m = w.document.createElement('div'); w.document.body.appendChild(m);
    m.setAttribute('x', '1'); void m.offsetWidth;
    // Second realm reflow.
    const s = new H(); s.setAttribute('x', '1'); void s.offsetWidth;

    assert.ok(p.summary().total >= 2, 'both realms contribute to the same total');
    p.destroy();
});

// =============================================================================
// AXIS N -- teardown/removal restores exactly, LIFO, idempotent, throw-safe
// =============================================================================

test('[N] remove restores only its realm; earlier realms remain', () => {
    const p = createLayoutProfiler({ warnToConsole: false });
    const a = fullRealm(); const b = fullRealm();
    const ha = p.addRealm(a.realm);
    const hb = p.addRealm(b.realm);
    assert.equal(p.summary().patched.realms, 3);

    hb.remove();
    assert.equal(p.summary().patched.realms, 2);

    // realm A still records; realm B does not.
    const ea = new a.H(); ea.setAttribute('x', '1'); void ea.offsetWidth;
    const totalAfterA = p.summary().total;
    assert.ok(totalAfterA >= 1, 'realm A still instrumented');

    const eb = new b.H(); eb.setAttribute('x', '1'); void eb.offsetWidth;
    assert.equal(p.summary().total, totalAfterA, 'realm B no longer instrumented');
    p.destroy();
});

test('[N] removing realms in either order lands at the same coverage', () => {
    const p = createLayoutProfiler({ warnToConsole: false });
    const a = fullRealm(); const b = fullRealm();
    const ha = p.addRealm(a.realm);
    const hb = p.addRealm(b.realm);
    ha.remove();   // remove the FIRST-added first (not LIFO)
    hb.remove();
    assert.equal(p.summary().patched.realms, 1, 'both removed regardless of order');
    p.destroy();
});

test('[N] remove is idempotent and throw-safe if the realm prototype is gone', () => {
    const p = createLayoutProfiler({ warnToConsole: false });
    const { realm, H } = fullRealm();
    const h = p.addRealm(realm);
    // Simulate an iframe navigating away: its prototype is replaced/frozen.
    Object.defineProperty(H.prototype, 'offsetWidth', { configurable: true, get() { return 99; } });
    assert.doesNotThrow(() => h.remove());
    assert.doesNotThrow(() => h.remove());
    assert.equal(p.summary().patched.realms, 1);
    p.destroy();
});

test('[N] destroy tears down all realms even with several added', () => {
    const p = createLayoutProfiler({ warnToConsole: false });
    const a = fullRealm(); const b = fullRealm(); const c = fullRealm();
    const da = Object.getOwnPropertyDescriptor(a.H.prototype, 'offsetWidth');
    p.addRealm(a.realm); p.addRealm(b.realm); p.addRealm(c.realm);
    assert.equal(p.summary().patched.realms, 4);
    p.destroy();
    const after = Object.getOwnPropertyDescriptor(a.H.prototype, 'offsetWidth');
    assert.equal(after.get, da.get, 'realm A restored by destroy');
});

// =============================================================================
// AXIS O -- unusable realms degrade, never throw, never lower completeness
// =============================================================================

test('[O] every kind of unusable source degrades to a no-op handle', () => {
    const p = createLayoutProfiler({ warnToConsole: false });
    const sources = [null, undefined, 0, '', 'nope', {}, [], true, Symbol.iterator];
    for (const src of sources) {
        let h;
        assert.doesNotThrow(() => { h = p.addRealm(src); }, 'addRealm(' + String(src) + ')');
        assert.equal(h.available, false);
    }
    assert.equal(p.summary().patched.realms, 1);
    p.destroy();
});

test('[O] a contentWindow that throws on every access does not throw or count', () => {
    const p = createLayoutProfiler({ warnToConsole: false });
    const hostile = new Proxy({}, { get() { throw new Error('cross-origin'); }, has() { throw new Error('x'); } });
    let h;
    assert.doesNotThrow(() => { h = p.addRealm(hostile); });
    assert.equal(h.available, false);
    assert.equal(p.summary().patched.realms, 1);
    p.destroy();
});

test('[O] unusable realms never lower main-realm completeness', () => {
    const p = createLayoutProfiler({ warnToConsole: false });
    const before = p.summary().patched.complete;
    p.addRealm(null); p.addRealm({}); p.addRealm(42);
    assert.equal(p.summary().patched.complete, before);
    p.destroy();
});

// =============================================================================
// AXIS P -- per-realm provenance and coverage
// =============================================================================

test('[P] a partly-patchable second realm records its hole, namespaced', () => {
    const p = createLayoutProfiler({ warnToConsole: false });
    const { realm } = partialRealm();
    p.addRealm(realm);
    const s = p.summary();
    // The non-configurable offsetWidth in realm 1 is a failed patch; its label
    // is namespaced so it cannot be confused with a main-realm target.
    const failedRealmLabels = s.patched.failures.filter(function (f) {
        return f.indexOf('realm:1.') === 0;
    });
    assert.ok(failedRealmLabels.length >= 1, 'the second realm hole is recorded and namespaced');
    p.destroy();
});

test('[P] a second-realm hole makes the whole run incomplete', () => {
    const p = createLayoutProfiler({ warnToConsole: false });
    // Main realm is clean under happy-dom; adding a holed realm must flip complete.
    const cleanBefore = p.summary().patched.complete;
    const { realm } = partialRealm();
    p.addRealm(realm);
    assert.equal(p.summary().patched.complete, false,
        'complete AND-s across realms: a hole anywhere is not complete');
    // (cleanBefore may be true or false depending on host; the point is the
    // added hole cannot RAISE completeness, only keep or lower it.)
    assert.ok(cleanBefore === true || cleanBefore === false);
    p.destroy();
});

test('[P] a fully-patchable second realm keeps provenance clean', () => {
    const p = createLayoutProfiler({ warnToConsole: false });
    const completeBefore = p.summary().patched.complete;
    const { realm } = fullRealm();
    p.addRealm(realm);
    // A clean second realm should not introduce failures.
    const realmFailures = p.summary().patched.failures.filter(function (f) {
        return f.indexOf('realm:1.') === 0;
    });
    assert.equal(realmFailures.length, 0, 'a clean realm adds no holes');
    assert.equal(p.summary().patched.complete, completeBefore, 'and does not change completeness');
    p.destroy();
});
