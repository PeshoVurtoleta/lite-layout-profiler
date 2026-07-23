// L3.5 -- Clock pathology and cost recording. Axis G.
//
// The cost lane trusts exactly one thing about its environment: that a clock
// returns increasing numbers. Nothing enforces that. Browsers coarsen the
// clock, virtualised hosts stall it, a caller can inject anything at all
// through `options.clock`, and a page that changes timezone or runs under a
// debugger can see it move backwards.
//
// The invariant under test throughout: a clock that cannot be trusted must
// produce no measurement, never a wrong one.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createLayoutProfiler, checkNoReflow } from '../../LayoutProfiler.js';
import { installDom, removeDom, makeClock } from './harness.mjs';

let live = null;
afterEach(() => {
    if (live) { try { live.destroy(); } catch (e) { void e; } live = null; }
    removeDom();
});

function start(opts) {
    live = createLayoutProfiler(Object.assign({ warnToConsole: false }, opts));
    return live;
}

function thrash(dom, n) {
    const el = dom.make();
    for (let i = 0; i < (n || 1); i++) {
        el.style.width = i + 'px';
        void el.offsetWidth;
    }
    return el;
}

// ---------------------------------------------------------------------------
// Axis G -- hostile clocks
// ---------------------------------------------------------------------------

test('G: a frozen clock yields no resolution and no measurements', () => {
    const dom = installDom();
    const started = Date.now();
    const p = start({ clock: makeClock('frozen') });
    assert.ok(Date.now() - started < 2000,
        'the resolution probe must be bounded even when the clock never moves');

    const s = p.summary();
    assert.equal(s.cost.resolutionMs, null, 'a clock that never advances has no floor');

    thrash(dom, 3);
    const s2 = p.summary();
    assert.equal(s2.total, 3, 'detection must keep working without a clock');
    assert.equal(s2.cost.measured, 0);
    assert.equal(s2.cost.totalMs, null, 'no measurements means no total, not zero');
});

test('G: a frozen clock makes cost rules unverifiable, not passing', () => {
    const dom = installDom();
    const p = start({ clock: makeClock('frozen') });
    thrash(dom, 3);
    const rep = checkNoReflow(p.summary(), { maxReflows: 99, maxCostMs: 1e9 });
    assert.equal(rep.ok, false);
    assert.equal(rep.verified, false);
});

test('G: a clock running backwards produces no negative durations', () => {
    const dom = installDom();
    const p = start({ clock: makeClock('backwards') });
    thrash(dom, 5);

    const s = p.summary();
    for (const r of s.records) {
        assert.ok(r.costMs === null || r.costMs >= 0,
            'a negative elapsed time is not a duration, got ' + r.costMs);
    }
    assert.equal(s.cost.measured, 0, 'nothing measurable can come from a reversed clock');
});

test('G: a NaN clock measures nothing and crashes nothing', () => {
    const dom = installDom();
    let p;
    assert.doesNotThrow(() => { p = start({ clock: makeClock('nan') }); });
    assert.equal(p.summary().cost.resolutionMs, null);
    assert.doesNotThrow(() => thrash(dom, 3));

    const s = p.summary();
    assert.equal(s.total, 3);
    assert.equal(s.cost.measured, 0);
    for (const r of s.records) assert.equal(r.costMs, null);
});

test('G: an infinite clock measures nothing', () => {
    const dom = installDom();
    const p = start({ clock: makeClock('infinite') });
    assert.equal(p.summary().cost.resolutionMs, null);
    thrash(dom, 2);
    assert.equal(p.summary().cost.measured, 0);
});

test('G: a clock returning strings never mints a cost from coercion', () => {
    const dom = installDom();
    let p;
    assert.doesNotThrow(() => { p = start({ clock: makeClock('string') }); });
    assert.doesNotThrow(() => thrash(dom, 3));
    for (const r of p.summary().records) {
        assert.ok(r.costMs === null || (typeof r.costMs === 'number' && isFinite(r.costMs)),
            'costMs must be a real number or null, got ' + JSON.stringify(r.costMs));
    }
});

test('G: a throwing clock fails at construction, not silently at measure time', () => {
    installDom();
    assert.throws(() => createLayoutProfiler({
        warnToConsole: false, clock: makeClock('throwing')
    }), /hostile clock/, 'a broken clock must surface immediately');
});

test('G: measureCost false makes a hostile clock irrelevant', () => {
    const dom = installDom();
    const p = start({ clock: makeClock('throwing'), measureCost: false });
    assert.doesNotThrow(() => thrash(dom, 3));
    assert.equal(p.summary().total, 3, 'counts survive without any clock at all');
});

test('G: a jittering clock does not invent or lose reflows', () => {
    const dom = installDom();
    const p = start({ clock: makeClock('jitter') });
    thrash(dom, 20);
    const s = p.summary();
    assert.equal(s.total, 20, 'jitter must not change what was detected');
    assert.equal(s.cost.measured + s.cost.unmeasured, s.stored);
});

test('G: a non-function clock option falls back to the default', () => {
    const dom = installDom();
    for (const bad of [42, 'now', null, {}, []]) {
        const p = createLayoutProfiler({ warnToConsole: false, clock: bad });
        assert.doesNotThrow(() => thrash(dom, 1));
        assert.doesNotThrow(() => p.summary());
        p.destroy();
    }
});

// ---------------------------------------------------------------------------
// Cost accounting invariants
// ---------------------------------------------------------------------------

test('measured plus unmeasured always equals stored', () => {
    const dom = installDom();
    for (const kind of ['normal', 'frozen', 'backwards', 'jitter', 'nan']) {
        const p = createLayoutProfiler({ warnToConsole: false, clock: makeClock(kind) });
        thrash(dom, 7);
        const s = p.summary();
        assert.equal(s.cost.measured + s.cost.unmeasured, s.stored, 'clock=' + kind);
        p.destroy();
    }
});

test('aggregates are internally consistent whenever anything was measured', () => {
    const dom = installDom();
    const clock = makeClock('normal', 0.05);
    const p = start({ clock });
    dom.advance = clock.jump;

    const el = dom.make();
    for (const c of [1, 2, 3, 8, 13]) {
        dom.readCost = c;
        el.style.width = c + 'px';
        void el.offsetWidth;
    }

    const s = p.summary();
    assert.ok(s.cost.measured > 0);
    assert.ok(s.cost.maxMs >= s.cost.avgMs, 'max must not be under the average');
    assert.ok(s.cost.totalMs >= s.cost.maxMs, 'total must not be under the max');
    assert.ok(s.cost.p99Ms <= s.cost.maxMs, 'p99 must not exceed the max');
    const observed = s.records
        .filter((r) => r.costMs !== null)
        .reduce((a, r) => a + r.costMs, 0);
    assert.ok(Math.abs(observed - s.cost.totalMs) < 1e-9, 'total must equal the sum');
});

test('a stall exactly at the resolution floor is not a measurement', () => {
    const dom = installDom();
    let t = 0;
    const p = start({ clock: () => { t += 4; return t; } });
    assert.equal(p.summary().cost.resolutionMs, 4);

    thrash(dom, 1);
    const r = p.summary().records[0];
    assert.equal(r.costMs, null,
        'one tick spans (0, 2 x tick) and so contains zero: not a lower bound');
    assert.equal(r.belowGranularity, true);
});

test('belowGranularity is only claimed when a floor is actually known', () => {
    const dom = installDom();
    const p = start({ measureCost: false });
    thrash(dom, 2);
    for (const r of p.summary().records) {
        assert.equal(r.costMs, null);
        assert.equal(r.belowGranularity, false,
            'without a floor there is nothing to be below; the cost is simply absent');
    }
});

test('percentiles hold at every sample count from one upward', () => {
    const dom = installDom();
    for (const n of [1, 2, 3, 99, 100, 101]) {
        const clock = makeClock('normal', 0.05);
        const p = createLayoutProfiler({ warnToConsole: false, clock, maxStored: 500 });
        dom.advance = clock.jump;
        const el = dom.make();
        for (let i = 0; i < n; i++) {
            dom.readCost = 1 + (i % 5);
            el.style.width = i + 'px';
            void el.offsetWidth;
        }
        const c = p.summary().cost;
        assert.ok(c.p99Ms !== null && c.p99Ms <= c.maxMs, 'n=' + n);
        assert.ok(c.avgMs <= c.maxMs, 'n=' + n);
        p.destroy();
        dom.readCost = 0;
        dom.advance = () => {};
    }
});

test('the JSON round trip preserves null costs as null', () => {
    const dom = installDom();
    const p = start({ measureCost: false });
    thrash(dom, 3);
    const wire = JSON.parse(JSON.stringify(p.summary()));
    for (const r of wire.records) {
        assert.equal(r.costMs, null, 'null must not become undefined across JSON');
    }
    assert.equal(wire.cost.totalMs, null);
    assert.equal(checkNoReflow(wire, { maxReflows: 9, maxCostMs: 1 }).verified, false);
});
