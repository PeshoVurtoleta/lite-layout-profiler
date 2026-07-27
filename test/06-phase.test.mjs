// Phase lane + thrash collapsing (v1.3). Drives the real patcher against a
// stub DOM that also installs controllable schedulers (rAF, timers,
// microtask, ResizeObserver), so phase attribution is deterministic rather
// than dependent on a real event loop. Adversarial cases live in
// test/torture/l4-5-phase.test.mjs.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createLayoutProfiler, checkNoReflow, assertNoReflow, ReflowBudgetError } from '../LayoutProfiler.js';

// --- stub DOM + controllable schedulers ------------------------------------

let rafQueue = [];
let timerQueue = [];
let microQueue = [];
let roCallbacks = [];

function installStubDom() {
    function Node() {}
    Node.prototype.appendChild = function (c) { return c; };

    function Element() {}
    Element.prototype = Object.create(Node.prototype);
    Element.prototype.constructor = Element;
    Element.prototype.getBoundingClientRect = function () { return { width: 0, height: 0 }; };
    Object.defineProperty(Element.prototype, 'className', {
        get() { return this._c || ''; }, set(v) { this._c = v; }, configurable: true
    });

    function CSSStyleDeclaration() { this._p = {}; }
    CSSStyleDeclaration.prototype.setProperty = function (k, v) { this._p[k] = v; };
    for (const prop of ['width', 'height', 'transform']) {
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
            get() { return 100; }, set() {}, configurable: true
        });
    }

    function ResizeObserver(cb) { this._cb = cb; }
    ResizeObserver.prototype.observe = function () { roCallbacks.push(this._cb); };
    ResizeObserver.prototype.disconnect = function () {};

    globalThis.Node = Node;
    globalThis.Element = Element;
    globalThis.HTMLElement = HTMLElement;
    globalThis.CSSStyleDeclaration = CSSStyleDeclaration;
    globalThis.window = { getComputedStyle() { return new CSSStyleDeclaration(); } };
    globalThis.ResizeObserver = ResizeObserver;

    // Schedulers on globalThis (the unqualified call path). Deterministic:
    // callbacks queue and run only when the matching flush is called.
    globalThis.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
    globalThis.setTimeout = (cb) => { timerQueue.push(cb); return timerQueue.length; };
    globalThis.queueMicrotask = (cb) => { microQueue.push(cb); };

    return function makeElement() {
        const el = new HTMLElement();
        el.style = new CSSStyleDeclaration();
        return el;
    };
}

function flushRaf() { const q = rafQueue; rafQueue = []; q.forEach((cb) => cb(1)); }
function flushTimers() { const q = timerQueue; timerQueue = []; q.forEach((cb) => cb()); }
function flushRo() { const q = roCallbacks; roCallbacks = []; q.forEach((cb) => cb([], null)); }

function removeStubDom() {
    delete globalThis.Node;
    delete globalThis.Element;
    delete globalThis.HTMLElement;
    delete globalThis.CSSStyleDeclaration;
    delete globalThis.window;
    delete globalThis.ResizeObserver;
    delete globalThis.requestAnimationFrame;
    delete globalThis.setTimeout;
    delete globalThis.queueMicrotask;
}

let makeElement;
let profiler = null;

beforeEach(() => {
    rafQueue = []; timerQueue = []; microQueue = []; roCallbacks = [];
    makeElement = installStubDom();
});
afterEach(() => {
    if (profiler) { profiler.destroy(); profiler = null; }
    removeStubDom();
});

function start(opts) {
    profiler = createLayoutProfiler(Object.assign({ warnToConsole: false, phases: true }, opts));
    return profiler;
}

// --- phase attribution -----------------------------------------------------

test('a reflow inside requestAnimationFrame is phase raf', () => {
    const p = start();
    const el = makeElement();
    requestAnimationFrame(() => { el.style.width = '1px'; void el.offsetWidth; });
    flushRaf();

    const s = p.summary();
    assert.equal(s.total, 1);
    assert.equal(s.phases.raf, 1);
    assert.equal(s.records[0].phase, 'raf');
});

test('a reflow inside setTimeout is phase timer', () => {
    const p = start();
    const el = makeElement();
    setTimeout(() => { el.style.width = '1px'; void el.offsetWidth; });
    flushTimers();
    assert.equal(p.summary().phases.timer, 1);
});

test('a reflow inside queueMicrotask is phase microtask', () => {
    const p = start();
    const el = makeElement();
    queueMicrotask(() => { el.style.width = '1px'; void el.offsetWidth; });
    const q = microQueue; microQueue = []; q.forEach((cb) => cb());
    assert.equal(p.summary().phases.microtask, 1);
});

test('a reflow with no scheduler wrapper active is phase unknown, not guessed', () => {
    const p = start();
    const el = makeElement();
    el.style.width = '1px';       // top-level, no scheduler
    void el.offsetWidth;
    const s = p.summary();
    assert.equal(s.phases.unknown, 1);
    assert.equal(s.phases.raf, 0, 'an unobserved path must never be guessed as raf');
});

test('nested schedulers report the innermost active phase', () => {
    const p = start();
    const el = makeElement();
    // rAF schedules a timer; the reflow happens in the timer.
    requestAnimationFrame(() => {
        setTimeout(() => { el.style.width = '1px'; void el.offsetWidth; });
    });
    flushRaf();
    flushTimers();
    const s = p.summary();
    assert.equal(s.phases.timer, 1, 'the reflow ran in the timer, not the outer rAF');
    assert.equal(s.phases.raf, 0);
});

test('phase is restored after a scheduler callback returns', () => {
    const p = start();
    const el = makeElement();
    requestAnimationFrame(() => { el.style.width = '1px'; void el.offsetWidth; });
    flushRaf();
    // A top-level reflow after the rAF drained must be unknown, not raf.
    el.style.height = '2px';
    void el.offsetHeight;
    const s = p.summary();
    assert.equal(s.phases.raf, 1);
    assert.equal(s.phases.unknown, 1);
});

test('a throwing rAF callback still restores the phase', () => {
    const p = start();
    const el = makeElement();
    rafQueue.push(() => { throw new Error('boom'); });
    assert.throws(() => flushRaf(), /boom/);
    // Phase must have been popped in the finally; a later top-level reflow is unknown.
    el.style.width = '1px';
    void el.offsetWidth;
    assert.equal(p.summary().phases.unknown, 1);
});

// --- ResizeObserver feedback loop ------------------------------------------

test('a write-then-read inside a ResizeObserver callback is flagged roFeedback', () => {
    const p = start();
    const el = makeElement();
    const ro = new ResizeObserver(() => { el.style.width = '1px'; void el.offsetWidth; });
    ro.observe(el);
    flushRo();
    const s = p.summary();
    assert.equal(s.phases.roCallback, 1);
    assert.equal(s.records[0].roFeedback, true, 'RO write-then-read is a feedback loop');
});

test('a read-only ResizeObserver callback is not a feedback loop', () => {
    const p = start();
    const el = makeElement();
    // Write happens OUTSIDE, dirtying layout; the RO callback only reads.
    el.style.width = '1px';
    const ro = new ResizeObserver(() => { void el.offsetWidth; });
    ro.observe(el);
    flushRo();
    const s = p.summary();
    // It is a reflow in the ro-callback phase, but the callback itself did not
    // write, so it is not the self-perpetuating feedback shape.
    const roRec = s.records.find((r) => r.phase === 'ro-callback');
    assert.ok(roRec, 'the read should be attributed to the ro-callback phase');
    assert.equal(roRec.roFeedback, false);
});

// --- maxInRaf gate ---------------------------------------------------------

test('maxInRaf: 0 fails a reflow forced during render', () => {
    const p = start();
    const el = makeElement();
    requestAnimationFrame(() => { el.style.width = '1px'; void el.offsetWidth; });
    flushRaf();
    const rep = checkNoReflow(p.summary(), { maxReflows: 99, maxInRaf: 0 });
    assert.equal(rep.ok, false);
    assert.equal(rep.verified, true);
    assert.equal(rep.violations[0].metric, 'maxInRaf');
    assert.match(rep.violations[0].reason, /frame-killing/);
});

test('maxInRaf ignores reflows outside rAF', () => {
    const p = start();
    const el = makeElement();
    setTimeout(() => { el.style.width = '1px'; void el.offsetWidth; });
    flushTimers();
    const rep = checkNoReflow(p.summary(), { maxReflows: 99, maxInRaf: 0 });
    assert.equal(rep.ok, true, 'a timer reflow must not trip a rAF budget');
});

test('maxInRaf counts after allowlist exclusions', () => {
    const p = start();
    const el = makeElement();
    requestAnimationFrame(() => {
        el.style.width = '1px'; void el.getBoundingClientRect();   // excluded
        el.style.height = '2px'; void el.offsetWidth;              // counted
    });
    flushRaf();
    const rep = checkNoReflow(p.summary(), {
        maxReflows: 99, maxInRaf: 0, allowReads: ['getBoundingClientRect']
    });
    assert.equal(rep.violations[0].actual, 1, 'the excluded rAF reflow must not count');
});

test('maxInRaf is unverifiable when the phase lane was off', () => {
    // phases:false -> the wrappers were never installed.
    const p = createLayoutProfiler({ warnToConsole: false, phases: false });
    profiler = p;
    const el = makeElement();
    el.style.width = '1px';
    void el.offsetWidth;
    const rep = checkNoReflow(p.summary(), { maxReflows: 99, maxInRaf: 0 });
    assert.equal(rep.verified, false, 'cannot assert no-reflow-in-rAF if rAF was never watched');
    assert.equal(rep.ok, false);
    assert.ok(rep.violations.some((v) => v.metric === 'maxInRaf'));
});

test('with phases off, every record is phase unobserved', () => {
    const p = createLayoutProfiler({ warnToConsole: false, phases: false });
    profiler = p;
    const el = makeElement();
    el.style.width = '1px';
    void el.offsetWidth;
    const s = p.summary();
    assert.equal(s.phasesObserved, false);
    assert.equal(s.phases.unobserved, 1);
    assert.equal(s.records[0].phase, 'unobserved');
});

// --- thrash collapsing (does NOT need phases) ------------------------------

test('an identical read-after-write loop collapses into one thrash group', () => {
    const p = createLayoutProfiler({ warnToConsole: false });   // phases default off
    profiler = p;
    const el = makeElement();
    for (let i = 0; i < 8; i++) { el.style.width = i + 'px'; void el.offsetWidth; }
    const s = p.summary();
    assert.equal(s.total, 8, 'raw total is unchanged by collapsing');
    assert.equal(s.records.length, 8, 'summary.records stays the raw per-reflow view');
    assert.equal(s.thrash.length, 1, 'the loop collapses to one group');
    assert.equal(s.thrash[0].count, 8);
    assert.equal(s.maxThrashCount, 8);
});

test('distinct call sites do not collapse together', () => {
    const p = createLayoutProfiler({ warnToConsole: false });
    profiler = p;
    const el = makeElement();
    // Two different read sites in the same task.
    el.style.width = '1px'; void el.offsetWidth;
    el.style.height = '2px'; void el.offsetHeight;
    const s = p.summary();
    // Different (read, write, site) tuples -> two groups of count 1 -> no thrash.
    assert.equal(s.thrash.length, 0, 'single occurrences are not thrash');
    assert.equal(s.maxThrashCount, 0);
});

test('maxThrash: 1 fails a repeating tuple', () => {
    const p = createLayoutProfiler({ warnToConsole: false });
    profiler = p;
    const el = makeElement();
    for (let i = 0; i < 5; i++) { el.style.width = i + 'px'; void el.offsetWidth; }
    const rep = checkNoReflow(p.summary(), { maxReflows: 99, maxThrash: 1 });
    assert.equal(rep.ok, false);
    assert.equal(rep.violations[0].metric, 'maxThrash');
    assert.equal(rep.violations[0].actual, 5);
    assert.match(rep.violations[0].reason, /repeated 5 times/);
});

test('maxThrash passes when no tuple repeats within a block', () => {
    const p = createLayoutProfiler({ warnToConsole: false });
    profiler = p;
    const el = makeElement();
    el.style.width = '1px'; void el.offsetWidth;
    const rep = checkNoReflow(p.summary(), { maxReflows: 99, maxThrash: 1 });
    assert.equal(rep.ok, true);
});

test('collapsed thrash cost is the SUM of measured members', () => {
    const p = createLayoutProfiler({ warnToConsole: false });
    profiler = p;
    const el = makeElement();
    for (let i = 0; i < 4; i++) { el.style.width = i + 'px'; void el.offsetWidth; }
    const s = p.summary();
    if (s.thrash[0].costMs !== null) {
        // total across the group equals the sum of member costs (all same tuple)
        const memberSum = s.records
            .filter((r) => r.read === 'offsetWidth' && r.taskId === s.thrash[0].taskId)
            .reduce((a, r) => a + (r.costMs || 0), 0);
        assert.ok(Math.abs(memberSum - s.thrash[0].costMs) < 1e-9);
    }
});

// --- serialisation ---------------------------------------------------------

test('a v1.3 summary round-trips through JSON and still gates on phase and thrash', () => {
    const p = start();
    const el = makeElement();
    requestAnimationFrame(() => {
        for (let i = 0; i < 3; i++) { el.style.width = i + 'px'; void el.offsetWidth; }
    });
    flushRaf();
    const wire = JSON.parse(JSON.stringify(p.summary()));
    assert.equal(checkNoReflow(wire, { maxReflows: 99, maxInRaf: 0 }).ok, false);
    assert.equal(checkNoReflow(wire, { maxReflows: 99, maxThrash: 1 }).ok, false);
});

// --- teardown restores schedulers ------------------------------------------

test('destroy restores every wrapped scheduler', () => {
    const rafBefore = globalThis.requestAnimationFrame;
    const timeoutBefore = globalThis.setTimeout;
    const roBefore = globalThis.ResizeObserver;
    const p = start();
    assert.notEqual(globalThis.requestAnimationFrame, rafBefore, 'rAF should be wrapped while active');
    p.destroy();
    profiler = null;
    assert.equal(globalThis.requestAnimationFrame, rafBefore, 'rAF restored');
    assert.equal(globalThis.setTimeout, timeoutBefore, 'setTimeout restored');
    assert.equal(globalThis.ResizeObserver, roBefore, 'ResizeObserver restored');
});

test('assertNoReflow throws on a frame-killing rAF reflow', () => {
    const p = start();
    const el = makeElement();
    requestAnimationFrame(() => { el.style.width = '1px'; void el.offsetWidth; });
    flushRaf();
    assert.throws(() => assertNoReflow(p.summary(), { maxReflows: 99, maxInRaf: 0 }), ReflowBudgetError);
});
