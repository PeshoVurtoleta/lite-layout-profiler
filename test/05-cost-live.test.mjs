// Cost lane (v1.2), live. Drives the real patcher against a stub DOM with an
// injected clock of known granularity, so timer-resolution behaviour is
// deterministic instead of depending on how fine the host's clock happens
// to be. Also covers the v1.2 ring buffer.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createLayoutProfiler, checkNoReflow } from '../LayoutProfiler.js';

// --- stub DOM --------------------------------------------------------------
// `readCost` is how much the injected clock advances inside a layout getter,
// standing in for the browser's synchronous layout pass.

let readCost = 0;
let advance = null;

function installStubDom() {
    function Node() {}
    Node.prototype.appendChild = function (c) { return c; };

    function Element() {}
    Element.prototype = Object.create(Node.prototype);
    Element.prototype.constructor = Element;
    Element.prototype.setAttribute = function () {};
    Element.prototype.getBoundingClientRect = function () {
        advance(readCost);
        return { width: 0, height: 0 };
    };
    Object.defineProperty(Element.prototype, 'className', {
        get() { return ''; }, set() {}, configurable: true
    });

    function CSSStyleDeclaration() { this._p = {}; }
    CSSStyleDeclaration.prototype.setProperty = function () {};
    for (const prop of ['width', 'height']) {
        Object.defineProperty(CSSStyleDeclaration.prototype, prop, {
            get() { return this._p[prop] || ''; },
            set(v) { this._p[prop] = v; },
            configurable: true, enumerable: true
        });
    }

    function HTMLElement() {}
    HTMLElement.prototype = Object.create(Element.prototype);
    HTMLElement.prototype.constructor = HTMLElement;
    for (const m of ['offsetWidth', 'offsetHeight', 'clientWidth', 'scrollTop']) {
        Object.defineProperty(HTMLElement.prototype, m, {
            get() { advance(readCost); return 100; },
            set() {},
            configurable: true
        });
    }

    globalThis.Node = Node;
    globalThis.Element = Element;
    globalThis.HTMLElement = HTMLElement;
    globalThis.CSSStyleDeclaration = CSSStyleDeclaration;
    globalThis.window = { getComputedStyle() { return new CSSStyleDeclaration(); } };

    return () => {
        const el = new HTMLElement();
        el.style = new CSSStyleDeclaration();
        return el;
    };
}

// A clock that only moves when told to, except for a fixed tick per read so
// the resolution probe can find a floor.
function makeClock(tickMs) {
    let t = 1000;
    const fn = () => { t += tickMs; return t; };
    fn.jump = (ms) => { t += ms; };
    return fn;
}

let makeElement;
let profiler = null;

beforeEach(() => {
    makeElement = installStubDom();
    readCost = 0;
    advance = () => {};
});

afterEach(() => {
    if (profiler) { profiler.destroy(); profiler = null; }
    delete globalThis.Node;
    delete globalThis.Element;
    delete globalThis.HTMLElement;
    delete globalThis.CSSStyleDeclaration;
    delete globalThis.window;
});

function start(opts) {
    profiler = createLayoutProfiler(Object.assign({ warnToConsole: false }, opts));
    return profiler;
}

// --- resolution probe ------------------------------------------------------

test('probe finds the clock floor and reports it', () => {
    const clock = makeClock(0.25);
    advance = clock.jump;
    const p = start({ clock });
    assert.equal(p.summary().cost.resolutionMs, 0.25);
});

test('the default clock yields a positive resolution or an honest null', () => {
    const p = start();
    const res = p.summary().cost.resolutionMs;
    assert.ok(res === null || (typeof res === 'number' && res > 0),
        'resolution must be a positive number or null, got ' + res);
});

test('measureCost: false skips the probe entirely', () => {
    const p = start({ measureCost: false });
    assert.equal(p.summary().cost.resolutionMs, null);
});

// --- measurement -----------------------------------------------------------

test('a stall above the floor is measured', () => {
    const clock = makeClock(0.1);
    advance = clock.jump;
    const p = start({ clock });
    const el = makeElement();

    readCost = 5;
    el.style.width = '1px';
    void el.offsetWidth;

    const s = p.summary();
    assert.equal(s.total, 1);
    // The getter advanced the clock by 5, plus the tick the clock adds per call.
    assert.ok(s.records[0].costMs >= 5, 'costMs should include the stall');
    assert.equal(s.records[0].belowGranularity, false);
    assert.equal(s.cost.measured, 1);
    assert.equal(s.cost.unmeasured, 0);
});

test('a stall below the floor is null, not zero, and is flagged', () => {
    // Floor of 10 ms; the clock's own per-call tick is all that elapses.
    let t = 0;
    const coarse = () => { t += 10; return t; };
    advance = () => {};
    const p = start({ clock: coarse });
    assert.equal(p.summary().cost.resolutionMs, 10);

    const el = makeElement();
    // Two clock reads bracket the getter, so exactly one floor-tick elapses,
    // which is the smallest thing the clock can express: not a real number.
    el.style.width = '1px';
    void el.offsetWidth;

    const s = p.summary();
    assert.equal(s.total, 1);
    assert.equal(s.records[0].costMs, null, 'sub-resolution cost must be null');
    assert.equal(s.records[0].belowGranularity, true);
    assert.equal(s.cost.unmeasured, 1);
    assert.equal(s.cost.totalMs, null, 'no measurements means no total, not zero');
});

test('measureCost: false leaves every cost unmeasured', () => {
    const p = start({ measureCost: false });
    const el = makeElement();
    el.style.width = '1px';
    void el.offsetWidth;

    const s = p.summary();
    assert.equal(s.records[0].costMs, null);
    assert.equal(s.cost.measured, 0);
    assert.equal(s.cost.avgMs, null);
    assert.equal(s.cost.p99Ms, null);
    assert.equal(checkNoReflow(s, { maxReflows: 9, maxCostMs: 1 }).verified, false);
});

test('clean reads are not timed and cost nothing', () => {
    const clock = makeClock(0.1);
    advance = clock.jump;
    const p = start({ clock });
    const el = makeElement();

    readCost = 50;
    void el.offsetWidth;          // no pending write: not a violation
    void el.offsetWidth;

    assert.equal(p.summary().total, 0);
});

test('aggregates are computed over measured costs only', () => {
    const clock = makeClock(0.1);
    advance = clock.jump;
    const p = start({ clock });
    const el = makeElement();

    for (const c of [2, 4, 6]) {
        readCost = c;
        el.style.width = c + 'px';
        void el.offsetWidth;
    }

    const s = p.summary();
    assert.equal(s.cost.measured, 3);
    assert.ok(s.cost.totalMs >= 12);
    assert.ok(s.cost.maxMs >= 6);
    assert.ok(s.cost.avgMs >= 4);
    assert.equal(s.cost.p99Ms, s.cost.maxMs, 'p99 of three samples is the max');
});

test('getBoundingClientRect is timed the same way as a getter', () => {
    const clock = makeClock(0.1);
    advance = clock.jump;
    const p = start({ clock });
    const el = makeElement();

    readCost = 3;
    el.style.width = '1px';
    void el.getBoundingClientRect();

    const s = p.summary();
    assert.equal(s.records[0].read, 'getBoundingClientRect()');
    assert.ok(s.records[0].costMs >= 3);
});

test('a real cost budget fails an expensive run and passes a cheap one', () => {
    const clock = makeClock(0.1);
    advance = clock.jump;

    const p1 = start({ clock });
    const a = makeElement();
    readCost = 9;
    a.style.width = '1px';
    void a.offsetWidth;
    const expensive = p1.summary();
    p1.destroy();
    profiler = null;

    const clock2 = makeClock(0.1);
    advance = clock2.jump;
    const p2 = start({ clock: clock2 });
    const b = makeElement();
    readCost = 0.5;
    b.style.width = '1px';
    void b.offsetWidth;
    const cheap = p2.summary();

    const rules = { maxReflows: 9, maxCostMs: 4 };
    assert.equal(checkNoReflow(expensive, rules).ok, false);
    assert.equal(checkNoReflow(cheap, rules).ok, true);
});

// --- ring buffer -----------------------------------------------------------

test('the ring keeps the newest records when it overflows', () => {
    const p = start({ maxStored: 3 });
    const el = makeElement();
    for (let i = 0; i < 10; i++) {
        el.style.width = i + 'px';
        void el.offsetWidth;
    }
    const s = p.summary();
    assert.equal(s.total, 10);
    assert.equal(s.stored, 3);
    assert.deepEqual(s.records.map((r) => r.id), [8, 9, 10]);
});

test('records stay in chronological order across several wraps', () => {
    const p = start({ maxStored: 4 });
    const el = makeElement();
    for (let i = 0; i < 21; i++) {
        el.style.width = i + 'px';
        void el.offsetWidth;
    }
    const ids = p.summary().records.map((r) => r.id);
    assert.deepEqual(ids, [18, 19, 20, 21]);
    assert.deepEqual(ids.slice().sort((a, b) => a - b), ids);
});

test('violations getter returns a stable snapshot that does not mutate', () => {
    const p = start();
    const el = makeElement();
    el.style.width = '1px';
    void el.offsetWidth;

    const first = p.violations;
    assert.equal(first.length, 1);
    el.style.width = '2px';
    void el.offsetWidth;
    assert.equal(first.length, 1, 'previously returned array must not grow');
    assert.equal(p.violations.length, 2);
});

test('reset empties the ring and later records start fresh', () => {
    const p = start({ maxStored: 3 });
    const el = makeElement();
    for (let i = 0; i < 5; i++) {
        el.style.width = i + 'px';
        void el.offsetWidth;
    }
    p.reset();
    assert.equal(p.summary().total, 0);
    assert.equal(p.summary().stored, 0);
    assert.deepEqual(p.violations, []);

    el.style.width = 'x';
    void el.offsetWidth;
    assert.equal(p.summary().stored, 1);
});

test('a cap of one still records the most recent reflow', () => {
    const p = start({ maxStored: 1 });
    const el = makeElement();
    for (let i = 0; i < 4; i++) {
        el.style.width = i + 'px';
        void el.offsetWidth;
    }
    const s = p.summary();
    assert.equal(s.stored, 1);
    assert.equal(s.records[0].id, 4);
    assert.equal(s.truncated, true);
});

// --- end to end ------------------------------------------------------------

test('summary survives JSON and gates on cost on the far side', () => {
    const clock = makeClock(0.1);
    advance = clock.jump;
    const p = start({ clock });
    const el = makeElement();

    readCost = 7;
    el.style.width = '1px';
    void el.offsetWidth;

    const wire = JSON.parse(JSON.stringify(p.summary()));
    const r = checkNoReflow(wire, { maxReflows: 9, maxCostMs: 4 });
    assert.equal(r.ok, false);
    assert.equal(r.verified, true);
    assert.equal(r.violations[0].metric, 'maxCostMs');
});
