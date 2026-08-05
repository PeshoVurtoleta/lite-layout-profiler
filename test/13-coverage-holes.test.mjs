// Coverage-hole and fail-open regression suite.
//
// This suite pins down four things the prior suites left uncovered, two of
// which are genuine fail-opens in a tool whose entire job is to fail closed:
//
//   A. Grouped patchers (per-property CSS setters, window metrics) must report a
//      present-but-refused target as a HOLE, not swallow it. A single
//      non-configurable member of the group must drop patched.complete to false.
//   B. A summary that claims more `total` than it carries `records` -- without
//      the truncated flag -- must make per-record rules unverifiable, exactly as
//      truncated:true does. Otherwise a short (or forged) record set gates green.
//   C. Every documented read that had no detection test: SVG getCTM/getScreenCTM,
//      window innerHeight/scrollX/pageXOffset/pageYOffset, window scroll methods.
//   D. warnToConsole actually emits (and suppresses) a console.warn.
//
// Realms are SYNTHETIC (fresh constructors with distinct prototypes), the same
// strategy 11-realm.test.mjs uses: happy-dom shares prototypes across Windows,
// so a synthetic realm is the only way to hold a getter non-configurable without
// poisoning the shared host prototype for the next test.
//
// Every profiler is registered and torn down in afterEach (reverse order), so a
// failing assertion cannot strand a main-realm wrapper and make the NEXT test's
// clean run look foreign. Wrappers stack; last created is first destroyed.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createLayoutProfiler, checkNoReflow } from '../LayoutProfiler.js';

// A main-realm DOM so createLayoutProfiler binds an active profiler (addRealm
// is inactive on a no-op profiler). node:test isolates each file in its own
// process, so these globals do not leak into other suites.
function installMainDom() {
    const w = new Window();
    for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement',
        'CSSStyleDeclaration', 'DOMTokenList']) {
        globalThis[k] = k === 'window' ? w : (k === 'document' ? w.document : w[k]);
    }
    return w;
}
installMainDom();

let profilers = [];
function start(opts) {
    const p = createLayoutProfiler(Object.assign({ warnToConsole: false }, opts));
    profilers.push(p);
    return p;
}
afterEach(() => {
    for (let i = profilers.length - 1; i >= 0; i--) {
        try { profilers[i].destroy(); } catch (e) { void e; }
    }
    profilers = [];
});

// A synthetic realm with one write path (setAttribute dirties layout) and every
// read this suite exercises, all as its OWN distinct prototypes/objects.
function fullRealm() {
    function E() {}
    E.prototype.setAttribute = function () { /* mutate -> dirty */ };
    E.prototype.scrollTo = function () {};
    E.prototype.scrollBy = function () {};
    E.prototype.scrollIntoView = function () {};
    function SVG() {}
    SVG.prototype.getBBox = function () { return {}; };
    SVG.prototype.getCTM = function () { return null; };
    SVG.prototype.getScreenCTM = function () { return null; };
    const win = {};
    for (const n of ['innerWidth', 'innerHeight', 'scrollX', 'scrollY', 'pageXOffset', 'pageYOffset']) {
        Object.defineProperty(win, n, { configurable: true, get() { return 0; } });
    }
    win.scrollTo = function () {};
    win.scrollBy = function () {};
    win.scroll = function () {};
    return { realm: { Element: E, HTMLElement: E, SVGGraphicsElement: SVG, window: win }, E, SVG, win };
}

// ---------------------------------------------------------------------------
// A. Grouped patchers must fail closed on a present-but-refused target
// ---------------------------------------------------------------------------

test('a non-configurable per-property CSS setter is a hole, not a silent skip', () => {
    // A CSSStyleDeclaration.prototype with one patchable setter and one that
    // refuses instrumentation. The group must be reported incomplete: a write
    // through `height` would never dirty, so a later reflow could go unseen.
    function E() {}
    function CSS() {}
    Object.defineProperty(CSS.prototype, 'width', {
        configurable: true, enumerable: true,
        get() { return this._w; }, set(v) { this._w = v; }
    });
    Object.defineProperty(CSS.prototype, 'height', {
        configurable: false, enumerable: true,          // present, refused -> hole
        get() { return this._h; }, set(v) { this._h = v; }
    });

    const p = start();
    assert.equal(p.summary().patched.complete, true, 'the main realm starts complete');

    const h = p.addRealm({ Element: E, HTMLElement: E, CSSStyleDeclaration: CSS });
    assert.equal(h.available, true);

    assert.equal(p.summary().patched.complete, false,
        'a refused per-property setter must drop completeness');
});

test('a non-configurable window metric getter is a hole, not a silent skip', () => {
    function E() {}
    const win = {};
    Object.defineProperty(win, 'innerWidth', { configurable: true, get() { return 0; } });
    Object.defineProperty(win, 'scrollY', { configurable: false, get() { return 0; } }); // hole

    const p = start();
    assert.equal(p.summary().patched.complete, true);

    p.addRealm({ Element: E, HTMLElement: E, window: win });

    assert.equal(p.summary().patched.complete, false,
        'a refused window-metric getter must drop completeness');
});

test('a fully-configurable grouped patch keeps completeness intact', () => {
    // The complement: when every member of the group is patchable, the run stays
    // complete. Proves the hole detection is not a blanket false-positive.
    const { realm } = fullRealm();
    const p = start();
    p.addRealm(realm);
    assert.equal(p.summary().patched.complete, true,
        'a clean synthetic realm does not lower completeness');
});

// ---------------------------------------------------------------------------
// B. records.length < total (untruncated) must be unverifiable
// ---------------------------------------------------------------------------

test('a summary claiming more total than it carries records is unverifiable', () => {
    // Produce a real, well-formed 3-record summary, then forge its total up to
    // 100 while leaving truncated:false. This is the exact internally-inconsistent
    // shape the gate ingests from serialized/foreign JSON. Per-record rules must
    // refuse to evaluate; only maxReflows (which reads `total`) may survive.
    const p = start();
    const el = document.createElement('div');
    document.body.appendChild(el);
    for (let i = 0; i < 3; i++) { el.style.width = (10 + i) + 'px'; void el.offsetWidth; }
    const s = p.summary();

    assert.equal(s.records.length, 3);
    assert.equal(s.truncated, false);
    s.total = 100;                       // forge: 100 claimed, 3 carried, not truncated

    const report = checkNoReflow(s, { maxReflows: 200, maxPerTask: 50 });
    assert.equal(report.verified, false,
        'fewer records than total without a truncation flag cannot be gated on shape');
    // Reported under the `records` evidence key, exactly as truncated:true is.
    const evidence = report.violations.find((v) => v.metric === 'records');
    assert.ok(evidence, 'the incomplete record set is reported as unverifiable evidence');
    assert.match(evidence.reason, /fewer records/);
});

test('records exactly equal to total stay verifiable', () => {
    // The boundary: no inconsistency, so the same rules verify normally.
    const p = start();
    const el = document.createElement('div');
    document.body.appendChild(el);
    for (let i = 0; i < 3; i++) { el.style.width = (10 + i) + 'px'; void el.offsetWidth; }
    const s = p.summary();

    const report = checkNoReflow(s, { maxReflows: 200, maxPerTask: 50 });
    assert.equal(report.verified, true, 'a consistent record set gates normally');
});

// ---------------------------------------------------------------------------
// C. Detection coverage for the previously-untested reads
// ---------------------------------------------------------------------------

// Trigger one write (dirty) then one read in a synthetic realm, return summary.
function readAfterWrite(triggerRead) {
    const { realm, E } = fullRealm();
    const p = start();
    p.addRealm(realm);
    const el = new E();
    el.setAttribute('data-x', '1');        // dirties layout in the added realm
    triggerRead(realm, el);                 // forced read
    return p.summary();
}

for (const metric of ['innerHeight', 'scrollX', 'pageXOffset', 'pageYOffset']) {
    test('window.' + metric + ' read after a write flags a forced reflow', () => {
        const s = readAfterWrite((realm) => { void realm.window[metric]; });
        assert.ok(s.total >= 1, metric + ' should be detected');
        assert.equal(s.byRead[metric], 1);
    });
}

for (const svg of ['getCTM', 'getScreenCTM']) {
    test('SVG ' + svg + '() after a write flags a forced reflow', () => {
        const s = readAfterWrite((realm) => { new realm.SVGGraphicsElement()[svg](); });
        assert.ok(s.total >= 1, svg + ' should be detected');
        assert.equal(s.byRead[svg + '()'], 1);
    });
}

for (const m of ['scrollTo', 'scrollBy', 'scroll']) {
    test('window.' + m + '() after a write flags a forced reflow', () => {
        const s = readAfterWrite((realm) => { realm.window[m](0, 0); });
        assert.ok(s.total >= 1, 'window.' + m + ' should be detected');
        assert.equal(s.byRead[m + '()'], 1);
    });
}

test('Element.scrollBy() after a write flags a forced reflow', () => {
    const s = readAfterWrite((realm, el) => { el.scrollBy(0, 10); });
    assert.ok(s.total >= 1);
    assert.equal(s.byRead['scrollBy()'], 1);
});

// ---------------------------------------------------------------------------
// D. warnToConsole emits, and suppresses, a console.warn
// ---------------------------------------------------------------------------

function withWarnSpy(fn) {
    const original = console.warn;
    const calls = [];
    console.warn = (...args) => { calls.push(args.join(' ')); };
    try { fn(calls); } finally { console.warn = original; }
}

test('warnToConsole: true emits a console.warn per forced reflow', () => {
    withWarnSpy((calls) => {
        const { realm, E } = fullRealm();
        const p = start({ warnToConsole: true });
        p.addRealm(realm);
        const el = new E();
        el.setAttribute('data-x', '1');
        void realm.window.innerHeight;
        assert.equal(calls.length, 1, 'exactly one warning for one reflow');
        assert.match(calls[0], /Forced reflow/);
        assert.match(calls[0], /innerHeight/);
    });
});

test('warnToConsole: false emits nothing', () => {
    withWarnSpy((calls) => {
        const { realm, E } = fullRealm();
        const p = start({ warnToConsole: false });
        p.addRealm(realm);
        const el = new E();
        el.setAttribute('data-x', '1');
        void realm.window.innerHeight;
        assert.equal(calls.length, 0, 'no warnings when warnToConsole is off');
    });
});
