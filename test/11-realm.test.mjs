// Cross-realm / iframe lane (v1.7). One profiler can instrument additional
// realms so a reflow forced through an iframe's element lands in the same
// records, summary, and gate.
//
// A note on the test strategy: happy-dom does NOT separate realms at the
// prototype level -- two Windows, and even a real <iframe>.contentWindow, share
// the same HTMLElement.prototype. A real browser gives each frame distinct
// prototypes. So these tests build SYNTHETIC realms (fresh constructor objects
// with their own prototypes), which is exactly what addRealm's descriptor form
// accepts and exactly what patchGetter/patchMethod operate on. The machinery is
// proven faithfully here; the real-browser end-to-end is a documented boundary,
// the same posture the cost lane takes ("only a real engine proves the
// measurement").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createLayoutProfiler } from '../LayoutProfiler.js';

// Install a main-realm DOM for the profiler to bind its default realm to.
function installMainDom() {
    const w = new Window();
    for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement',
        'CSSStyleDeclaration', 'DOMTokenList']) {
        globalThis[k] = k === 'window' ? w : (k === 'document' ? w.document : w[k]);
    }
    return w;
}

// A synthetic realm: fresh Element/HTMLElement whose prototypes are genuinely
// distinct objects. setAttribute is a write path (dirties layout); offsetWidth
// is a read (forces reflow). A write-then-read is the reflow the tool catches.
function makeSyntheticRealm() {
    function E() {}
    E.prototype.setAttribute = function () { /* mutate */ };
    function H() {}
    H.prototype = Object.create(E.prototype);
    Object.defineProperty(H.prototype, 'offsetWidth', {
        configurable: true, get() { return 7; }
    });
    return { realm: { Element: E, HTMLElement: H }, ElementCtor: E, HTMLElementCtor: H };
}

installMainDom();

// ---------------------------------------------------------------------------
// realm count
// ---------------------------------------------------------------------------

test('a fresh profiler reports exactly one realm', () => {
    const p = createLayoutProfiler({ warnToConsole: false });
    assert.equal(p.summary().patched.realms, 1);
    p.destroy();
});

test('addRealm raises the realm count and returns an available handle', () => {
    const p = createLayoutProfiler({ warnToConsole: false });
    const { realm } = makeSyntheticRealm();
    const h = p.addRealm(realm);
    assert.equal(h.available, true);
    assert.equal(h.realmIndex, 1);
    assert.equal(p.summary().patched.realms, 2);
    p.destroy();
});

// ---------------------------------------------------------------------------
// the core behaviour: a second realm's reflow is caught only after it is added
// ---------------------------------------------------------------------------

test('a reflow in a second realm is NOT recorded before the realm is added', () => {
    const p = createLayoutProfiler({ warnToConsole: false });
    const { realm, HTMLElementCtor } = makeSyntheticRealm();
    const el = new HTMLElementCtor();
    // write-then-read through an un-added realm: invisible.
    el.setAttribute('data-x', '1');
    void el.offsetWidth;
    assert.equal(p.summary().total, 0);
    // sanity: the realm object is fine, just not instrumented yet.
    p.addRealm(realm);
    p.destroy();
});

test('a write-then-read in an added realm is recorded as a forced reflow', () => {
    const p = createLayoutProfiler({ warnToConsole: false });
    const { realm, HTMLElementCtor } = makeSyntheticRealm();
    p.addRealm(realm);
    const el = new HTMLElementCtor();
    el.setAttribute('data-x', '1');   // dirties layout in realm 2
    void el.offsetWidth;              // forced reflow
    const s = p.summary();
    assert.ok(s.total >= 1, 'the cross-realm reflow was caught');
    assert.equal(s.byRead.offsetWidth, 1);
    p.destroy();
});

// ---------------------------------------------------------------------------
// remove(): restores just this realm
// ---------------------------------------------------------------------------

test('handle.remove restores the realm and stops recording it', () => {
    const p = createLayoutProfiler({ warnToConsole: false });
    const { realm, HTMLElementCtor } = makeSyntheticRealm();
    const h = p.addRealm(realm);
    const el = new HTMLElementCtor();

    el.setAttribute('data-x', '1');
    void el.offsetWidth;
    const before = p.summary().total;
    assert.ok(before >= 1);

    h.remove();
    assert.equal(p.summary().patched.realms, 1, 'realm count drops back');

    // The getter is restored to the original: no new reflow recorded.
    el.setAttribute('data-y', '2');
    void el.offsetWidth;
    assert.equal(p.summary().total, before, 'no further reflow recorded after remove');
    assert.equal(el.offsetWidth, 7, 'the realm-2 getter returns its original value');
    p.destroy();
});

test('handle.remove is idempotent', () => {
    const p = createLayoutProfiler({ warnToConsole: false });
    const { realm } = makeSyntheticRealm();
    const h = p.addRealm(realm);
    h.remove();
    assert.doesNotThrow(() => h.remove());
    assert.equal(p.summary().patched.realms, 1);
    p.destroy();
});

test('the main realm keeps recording after a second realm is removed', () => {
    const w = globalThis.window;
    const p = createLayoutProfiler({ warnToConsole: false });
    const { realm } = makeSyntheticRealm();
    const h = p.addRealm(realm);
    h.remove();

    // Main-realm write-then-read still works.
    const el = w.document.createElement('div');
    w.document.body.appendChild(el);
    el.setAttribute('data-x', '1');
    void el.offsetWidth;
    assert.ok(p.summary().total >= 1, 'main realm still instrumented after remove');
    p.destroy();
});

// ---------------------------------------------------------------------------
// degrade: unusable / cross-origin realms
// ---------------------------------------------------------------------------

test('addRealm on null, a scalar, or an empty object is unavailable, not a throw', () => {
    const p = createLayoutProfiler({ warnToConsole: false });
    for (const bad of [null, 42, 'x', {}, []]) {
        const h = p.addRealm(bad);
        assert.equal(h.available, false);
        assert.equal(h.reason, 'unusable_realm');
        assert.equal(h.realmIndex, -1);
    }
    assert.equal(p.summary().patched.realms, 1, 'no unusable realm was counted');
    p.destroy();
});

test('a cross-origin frame (property access throws) degrades to unavailable', () => {
    const p = createLayoutProfiler({ warnToConsole: false });
    const crossOrigin = new Proxy({}, { get() { throw new Error('blocked'); } });
    const h = p.addRealm(crossOrigin);
    assert.equal(h.available, false);
    assert.equal(h.reason, 'unusable_realm');
    assert.equal(p.summary().patched.realms, 1);
    p.destroy();
});

test('an unusable realm does not lower completeness', () => {
    const p = createLayoutProfiler({ warnToConsole: false });
    const completeBefore = p.summary().patched.complete;
    p.addRealm(null);
    assert.equal(p.summary().patched.complete, completeBefore,
        'a blind spot we never claimed to see is not a coverage hole');
    p.destroy();
});

test('addRealm after destroy is inactive, not a throw', () => {
    const p = createLayoutProfiler({ warnToConsole: false });
    p.destroy();
    const { realm } = makeSyntheticRealm();
    const h = p.addRealm(realm);
    assert.equal(h.available, false);
    assert.equal(h.reason, 'inactive');
});

// ---------------------------------------------------------------------------
// destroy tears down all realms
// ---------------------------------------------------------------------------

test('destroy restores a second realm bit-for-bit', () => {
    const p = createLayoutProfiler({ warnToConsole: false });
    const { realm, HTMLElementCtor } = makeSyntheticRealm();
    const originalDesc = Object.getOwnPropertyDescriptor(HTMLElementCtor.prototype, 'offsetWidth');
    p.addRealm(realm);
    // patched: the descriptor changed identity.
    const patchedDesc = Object.getOwnPropertyDescriptor(HTMLElementCtor.prototype, 'offsetWidth');
    assert.notEqual(patchedDesc.get, originalDesc.get, 'the getter was wrapped');
    p.destroy();
    const restoredDesc = Object.getOwnPropertyDescriptor(HTMLElementCtor.prototype, 'offsetWidth');
    assert.equal(restoredDesc.get, originalDesc.get, 'destroy restored the original getter');
});
