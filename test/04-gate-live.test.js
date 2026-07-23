// Gate lane, live (v1.1). Drives the real patcher against a minimal stub DOM
// and asserts the differential that makes the gate meaningful: a thrashing
// loop FAILS and the same work batched PASSES. The stub is inline and
// dependency-free so this runs under plain `node --test`.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    createLayoutProfiler,
    checkNoReflow,
    assertNoReflow,
    ReflowBudgetError
} from '../LayoutProfiler.js';

// --- minimal stub DOM ------------------------------------------------------
// Only what the patcher touches: a Node -> Element -> HTMLElement chain, a
// CSSStyleDeclaration with real accessor properties, and a window object.

function installStubDom() {
    function Node() {}
    Object.defineProperty(Node.prototype, 'textContent', {
        get() { return this._text || ''; },
        set(v) { this._text = v; },
        configurable: true
    });
    Node.prototype.appendChild = function (c) { return c; };
    Node.prototype.insertBefore = function (c) { return c; };
    Node.prototype.removeChild = function (c) { return c; };
    Node.prototype.replaceChild = function (c) { return c; };

    function Element() { Node.call(this); }
    Element.prototype = Object.create(Node.prototype);
    Element.prototype.constructor = Element;
    Element.prototype.setAttribute = function () {};
    Element.prototype.removeAttribute = function () {};
    Element.prototype.toggleAttribute = function () {};
    Element.prototype.getBoundingClientRect = function () {
        return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0 };
    };
    Element.prototype.scrollIntoView = function () {};
    Object.defineProperty(Element.prototype, 'className', {
        get() { return this._class || ''; },
        set(v) { this._class = v; },
        configurable: true
    });
    Object.defineProperty(Element.prototype, 'innerHTML', {
        get() { return this._html || ''; },
        set(v) { this._html = v; },
        configurable: true
    });
    Object.defineProperty(Element.prototype, 'outerHTML', {
        get() { return this._outer || ''; },
        set(v) { this._outer = v; },
        configurable: true
    });

    function CSSStyleDeclaration() { this._p = {}; }
    CSSStyleDeclaration.prototype.setProperty = function (k, v) { this._p[k] = v; };
    CSSStyleDeclaration.prototype.removeProperty = function (k) { delete this._p[k]; };
    Object.defineProperty(CSSStyleDeclaration.prototype, 'cssText', {
        get() { return this._css || ''; },
        set(v) { this._css = v; },
        configurable: true
    });
    // Per-property setters, the path `el.style.width = X` actually takes.
    for (const prop of ['width', 'height', 'top', 'left', 'transform']) {
        Object.defineProperty(CSSStyleDeclaration.prototype, prop, {
            get() { return this._p[prop] || ''; },
            set(v) { this._p[prop] = v; },
            configurable: true,
            enumerable: true
        });
    }

    function HTMLElement() { Element.call(this); }
    HTMLElement.prototype = Object.create(Element.prototype);
    HTMLElement.prototype.constructor = HTMLElement;
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
        get() { return this._it || ''; },
        set(v) { this._it = v; },
        configurable: true
    });
    // Layout getters. Each returns a number; the value is irrelevant, the
    // fact that reading it is instrumented is the point.
    const metrics = [
        'offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft',
        'clientWidth', 'clientHeight', 'clientTop', 'clientLeft',
        'scrollWidth', 'scrollHeight', 'scrollTop', 'scrollLeft'
    ];
    for (const m of metrics) {
        Object.defineProperty(HTMLElement.prototype, m, {
            get() { return 100; },
            set() {},
            configurable: true
        });
    }

    const win = {
        getComputedStyle() { return new CSSStyleDeclaration(); },
        scrollTo() {}, scrollBy() {}, scroll() {}
    };
    for (const m of ['innerWidth', 'innerHeight', 'scrollX', 'scrollY']) {
        Object.defineProperty(win, m, { get() { return 0; }, configurable: true });
    }

    globalThis.Node = Node;
    globalThis.Element = Element;
    globalThis.HTMLElement = HTMLElement;
    globalThis.CSSStyleDeclaration = CSSStyleDeclaration;
    globalThis.window = win;

    return function makeElement() {
        const el = new HTMLElement();
        el.style = new CSSStyleDeclaration();
        return el;
    };
}

function removeStubDom() {
    delete globalThis.Node;
    delete globalThis.Element;
    delete globalThis.HTMLElement;
    delete globalThis.CSSStyleDeclaration;
    delete globalThis.window;
}

let makeElement;
let profiler = null;

beforeEach(() => { makeElement = installStubDom(); });
afterEach(() => {
    if (profiler) { profiler.destroy(); profiler = null; }
    removeStubDom();
});

function start(opts) {
    profiler = createLayoutProfiler(Object.assign({ warnToConsole: false }, opts));
    return profiler;
}

const tick = () => new Promise((r) => queueMicrotask(r));

// --- the differential ------------------------------------------------------

test('thrashing loop FAILS the gate, batched loop PASSES it', () => {
    const N = 50;

    // THRASH: write then read, N times in one synchronous block.
    const p1 = start();
    const a = makeElement();
    let sink = 0;
    for (let i = 0; i < N; i++) {
        a.style.width = i + 'px';
        sink += a.offsetWidth;        // forced reflow, every iteration
    }
    const thrash = p1.summary();
    p1.destroy();
    profiler = null;

    // BATCHED: read once up front, then write only.
    const p2 = start();
    const b = makeElement();
    sink += b.offsetWidth;            // clean read, layout not dirty
    for (let i = 0; i < N; i++) {
        b.style.width = i + 'px';     // writes batch, nothing forces layout
    }
    const batched = p2.summary();

    assert.equal(thrash.total, N, 'thrash loop should force one reflow per iteration');
    assert.equal(batched.total, 0, 'batched loop should force none');

    assert.equal(checkNoReflow(thrash).ok, false, 'thrash must FAIL');
    assert.equal(checkNoReflow(batched).ok, true, 'batched must PASS');
    assert.equal(sink > 0, true);
});

// --- task epochs -----------------------------------------------------------

test('reflows in one synchronous block share a taskId', () => {
    const p = start();
    const el = makeElement();
    for (let i = 0; i < 3; i++) {
        el.style.width = i + 'px';
        void el.offsetWidth;
    }
    const s = p.summary();
    assert.equal(s.total, 3);
    assert.equal(s.taskCount, 1);
    assert.equal(new Set(s.records.map((r) => r.taskId)).size, 1);
});

test('taskId advances across microtask checkpoints', async () => {
    const p = start();
    const el = makeElement();
    for (let round = 0; round < 3; round++) {
        el.style.width = round + 'px';
        void el.offsetWidth;
        await tick();
    }
    const s = p.summary();
    assert.equal(s.total, 3);
    assert.equal(s.taskCount, 3, 'each round should land in its own task');
    assert.equal(Object.values(s.byTask).every((c) => c === 1), true);
});

test('maxPerTask separates spread-out reflows from a thrash loop', async () => {
    // Three reflows, one per frame: bad but not a thrash. Same count in one
    // block is the pathology maxPerTask exists to name.
    const p1 = start();
    const el1 = makeElement();
    for (let i = 0; i < 3; i++) {
        el1.style.width = i + 'px';
        void el1.offsetWidth;
        await tick();
    }
    const spread = p1.summary();
    p1.destroy();
    profiler = null;

    const p2 = start();
    const el2 = makeElement();
    for (let i = 0; i < 3; i++) {
        el2.style.width = i + 'px';
        void el2.offsetWidth;
    }
    const burst = p2.summary();

    const rules = { maxReflows: 3, maxPerTask: 1 };
    assert.equal(checkNoReflow(spread, rules).ok, true);
    assert.equal(checkNoReflow(burst, rules).ok, false);
});

// --- summary integrity -----------------------------------------------------

test('summary records are a snapshot, not a live reference', () => {
    const p = start();
    const el = makeElement();
    el.style.width = '1px';
    void el.offsetWidth;

    const s = p.summary();
    assert.equal(s.records.length, 1);
    el.style.width = '2px';
    void el.offsetWidth;
    assert.equal(s.records.length, 1, 'snapshot must not grow after capture');
    assert.equal(p.summary().records.length, 2);
});

test('summary is JSON-serialisable and survives a round trip through the gate', () => {
    const p = start();
    const el = makeElement();
    el.style.width = '1px';
    void el.offsetWidth;

    const wire = JSON.parse(JSON.stringify(p.summary()));
    const r = checkNoReflow(wire, { maxPerTask: 5, maxReflows: 5 });
    assert.equal(r.ok, true);
    assert.equal(r.verified, true);
});

test('storage cap sets truncated, which fails per-record rules', () => {
    const p = start({ maxStored: 4 });
    const el = makeElement();
    for (let i = 0; i < 10; i++) {
        el.style.width = i + 'px';
        void el.offsetWidth;
    }
    const s = p.summary();
    assert.equal(s.total, 10);
    assert.equal(s.stored, 4);
    assert.equal(s.truncated, true);

    const r = checkNoReflow(s, { maxReflows: 20, maxPerTask: 20 });
    assert.equal(r.ok, false);
    assert.equal(r.verified, false);
});

test('legacy maxViolations option is still honoured as the storage cap', () => {
    const p = start({ maxViolations: 3 });
    const el = makeElement();
    for (let i = 0; i < 6; i++) {
        el.style.width = i + 'px';
        void el.offsetWidth;
    }
    const s = p.summary();
    assert.equal(s.stored, 3);
    assert.equal(s.total, 6);
});

test('captureStacks: false records the fact, and ignoreSites refuses to run', () => {
    const p = start({ captureStacks: false });
    const el = makeElement();
    el.style.width = '1px';
    void el.offsetWidth;

    const s = p.summary();
    assert.equal(s.stacks, false);
    assert.equal(checkNoReflow(s, { maxReflows: 5 }).ok, true);
    const r = checkNoReflow(s, { maxReflows: 5, ignoreSites: ['whatever'] });
    assert.equal(r.verified, false);
});

test('assertNoReflow throws on a real thrash loop', () => {
    const p = start();
    const el = makeElement();
    for (let i = 0; i < 5; i++) {
        el.style.width = i + 'px';
        void el.offsetWidth;
    }
    assert.throws(() => assertNoReflow(p.summary()), ReflowBudgetError);
});

test('a clean run under a real profiler asserts without throwing', () => {
    const p = start();
    const el = makeElement();
    const w = el.offsetWidth;
    el.style.width = (w + 10) + 'px';
    el.style.height = (w + 20) + 'px';
    assert.doesNotThrow(() => assertNoReflow(p.summary()));
});

test('destroy() restores the prototypes the gate depended on', () => {
    const p = start();
    const before = Object.getOwnPropertyDescriptor(
        globalThis.HTMLElement.prototype, 'offsetWidth').get;
    p.destroy();
    profiler = null;
    const after = Object.getOwnPropertyDescriptor(
        globalThis.HTMLElement.prototype, 'offsetWidth').get;
    assert.notEqual(before, after, 'patched getter should have been replaced');

    const el = makeElement();
    el.style.width = '5px';
    void el.offsetWidth;   // must record nothing now
    assert.equal(p.summary().total, 0);
});
