// L99.9 -- Extreme. Axes H and I.
//
//   Axis H -- capacity and retention. The ring is the only unbounded thing a
//   long-running page can hand this library, and every boundary around it
//   (zero, one, fractional, astronomical) is a place where a silent wrong
//   answer is cheaper to produce than a right one.
//
//   Axis I -- reentrancy. `onViolation` fires synchronously, inside the
//   offending task, while the dirty flag is still live. Anything that callback
//   does -- read, write, throw, destroy, reset -- happens in the middle of the
//   profiler's own bookkeeping.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createLayoutProfiler, checkNoReflow } from '../../LayoutProfiler.js';
import { installDom, removeDom, snapshotProtos, diffProtos } from './harness.mjs';

let live = null;
afterEach(() => {
    if (live) { try { live.destroy(); } catch (e) { void e; } live = null; }
    removeDom();
});

function start(opts) {
    live = createLayoutProfiler(Object.assign({ warnToConsole: false }, opts));
    return live;
}

const tick = () => new Promise((r) => queueMicrotask(r));

// ---------------------------------------------------------------------------
// Axis H -- capacity and retention
// ---------------------------------------------------------------------------

test('H: an invalid storage cap is refused, not silently replaced', () => {
    installDom();
    for (const bad of [0, -1, -100, 1.5, NaN, Infinity, -Infinity, '200', null, {}, []]) {
        assert.throws(() => createLayoutProfiler({ maxStored: bad, warnToConsole: false }),
            TypeError, 'maxStored = ' + String(bad));
    }
});

test('H: an absurd storage cap is refused rather than allocated', () => {
    installDom();
    assert.throws(() => createLayoutProfiler({ maxStored: 2 ** 32, warnToConsole: false }),
        TypeError, 'a cap beyond any real diagnostic need is a typo, not a request');
});

test('H: the deprecated option name is validated identically', () => {
    installDom();
    assert.throws(() => createLayoutProfiler({ maxViolations: 1.5, warnToConsole: false }),
        TypeError);
    assert.doesNotThrow(() => {
        const p = createLayoutProfiler({ maxViolations: 5, warnToConsole: false });
        p.destroy();
    });
});

test('H: a cap of one retains exactly the newest record forever', () => {
    const dom = installDom();
    const p = start({ maxStored: 1 });
    const el = dom.make();
    for (let i = 0; i < 1000; i++) {
        el.style.width = i + 'px';
        void el.offsetWidth;
    }
    const s = p.summary();
    assert.equal(s.stored, 1);
    assert.equal(s.total, 1000);
    assert.equal(s.records[0].id, 1000);
    assert.equal(s.truncated, true);
});

test('H: retention is exact at the cap, one under, and one over', () => {
    const dom = installDom();
    for (const [cap, n, expectFirst] of [[10, 9, 1], [10, 10, 1], [10, 11, 2]]) {
        const p = createLayoutProfiler({ maxStored: cap, warnToConsole: false });
        const el = dom.make();
        for (let i = 0; i < n; i++) {
            el.style.width = i + 'px';
            void el.offsetWidth;
        }
        const s = p.summary();
        assert.equal(s.stored, Math.min(cap, n), 'cap=' + cap + ' n=' + n);
        assert.equal(s.records[0].id, expectFirst, 'cap=' + cap + ' n=' + n);
        assert.equal(s.truncated, n > cap, 'cap=' + cap + ' n=' + n);
        p.destroy();
    }
});

test('H: ids stay strictly increasing across a hundred ring wraps', () => {
    const dom = installDom();
    const p = start({ maxStored: 8 });
    const el = dom.make();
    for (let i = 0; i < 800; i++) {
        el.style.width = i + 'px';
        void el.offsetWidth;
    }
    const ids = p.summary().records.map((r) => r.id);
    assert.equal(ids.length, 8);
    for (let i = 1; i < ids.length; i++) {
        assert.equal(ids[i], ids[i - 1] + 1, 'ring order broke at index ' + i);
    }
    assert.equal(ids[ids.length - 1], 800);
});

test('H: reset at every phase of the ring leaves it coherent', () => {
    const dom = installDom();
    const p = start({ maxStored: 4 });
    const el = dom.make();
    for (let pre = 0; pre < 9; pre++) {
        p.reset();
        for (let i = 0; i < pre; i++) {
            el.style.width = i + 'px';
            void el.offsetWidth;
        }
        const s = p.summary();
        assert.equal(s.stored, Math.min(4, pre), 'pre=' + pre);
        assert.equal(s.total, pre, 'pre=' + pre);
        const ids = s.records.map((r) => r.id);
        for (let i = 1; i < ids.length; i++) {
            assert.equal(ids[i], ids[i - 1] + 1, 'pre=' + pre);
        }
    }
});

test('H: a very large cap does not make reset expensive', () => {
    const dom = installDom();
    const p = start({ maxStored: 500000 });
    const el = dom.make();
    el.style.width = '1px';
    void el.offsetWidth;

    const started = Date.now();
    for (let i = 0; i < 200; i++) p.reset();
    assert.ok(Date.now() - started < 2000,
        'reset must cost what was stored, not what could have been');
});

test('H: a hundred thousand reflows stay accurate and bounded', () => {
    const dom = installDom();
    const p = start({ maxStored: 100, captureStacks: false, measureCost: false });
    const el = dom.make();
    for (let i = 0; i < 100000; i++) {
        el.style.width = i + 'px';
        void el.offsetWidth;
    }
    const s = p.summary();
    assert.equal(s.total, 100000, 'the exact count must survive any volume');
    assert.equal(s.stored, 100);
    assert.equal(checkNoReflow(s, { maxReflows: 200000 }).ok, true,
        'the exact count survives truncation, so a volume budget still applies');
    assert.equal(checkNoReflow(s, { maxReflows: 99999 }).ok, false);
    assert.equal(checkNoReflow(s, { maxReflows: 200000, maxPerTask: 5 }).verified, false,
        'but shape rules still refuse a torn record set');
});

test('H: the violations snapshot is not rebuilt when nothing changed', () => {
    const dom = installDom();
    const p = start();
    const el = dom.make();
    el.style.width = '1px';
    void el.offsetWidth;
    assert.equal(p.violations, p.violations, 'the cache must be reused between reads');
    el.style.width = '2px';
    void el.offsetWidth;
    assert.notEqual(p.violations.length, 1, 'the cache must invalidate on capture');
});

test('H: reset invalidates the violations snapshot', () => {
    const dom = installDom();
    const p = start();
    const el = dom.make();
    el.style.width = '1px';
    void el.offsetWidth;
    assert.equal(p.violations.length, 1);
    p.reset();
    assert.deepEqual(p.violations, []);
});

test('H: task ids remain distinct across many microtask checkpoints', async () => {
    const dom = installDom();
    const p = start({ maxStored: 300 });
    const el = dom.make();
    for (let i = 0; i < 200; i++) {
        el.style.width = i + 'px';
        void el.offsetWidth;
        await tick();
    }
    const s = p.summary();
    assert.equal(s.taskCount, 200, 'each checkpoint must open a new task');
    assert.equal(checkNoReflow(s, { maxReflows: 200, maxPerTask: 1 }).ok, true);
});

// ---------------------------------------------------------------------------
// Axis I -- reentrancy and callback hostility
// ---------------------------------------------------------------------------

test('I: a callback that reads layout does not recurse forever', () => {
    // The dirty flag must be cleared before the callback runs. If it is not,
    // the callback's own read is itself a violation, which fires the callback
    // again, and the stack goes.
    const dom = installDom();
    const el = [];
    let depth = 0;
    let maxDepth = 0;

    const p = start({
        onViolation() {
            depth++;
            if (depth > maxDepth) maxDepth = depth;
            if (depth < 50) void el[0].offsetWidth;
            depth--;
        }
    });
    el.push(dom.make());

    el[0].style.width = '1px';
    assert.doesNotThrow(() => { void el[0].offsetWidth; },
        'a reentrant read must not blow the stack');
    assert.equal(maxDepth, 1, 'the callback must not be able to trigger itself');
    assert.equal(p.summary().total, 1);
});

test('I: a callback that throws does not leave the dirty flag stuck', () => {
    const dom = installDom();
    let fired = 0;
    const p = start({
        onViolation() { fired++; throw new Error('hostile callback'); }
    });
    const el = dom.make();

    el.style.width = '1px';
    assert.throws(() => { void el.offsetWidth; }, /hostile callback/);
    assert.equal(fired, 1);

    // A clean read afterwards must not be flagged: the write was already paid for.
    void el.offsetWidth;
    assert.equal(p.summary().total, 1,
        'a thrown callback must not turn every later read into a violation');
});

test('I: a callback that writes to the DOM really does cause the next reflow', () => {
    // Not a bug in the profiler -- a debug overlay that writes inside
    // onViolation dirties layout inside the task being measured, and the next
    // read genuinely stalls. The tool reports the truth; the caller has to
    // stop lying to it. Pinned so nobody "fixes" the honest answer away.
    const dom = installDom();
    const overlay = dom.make();
    const p = start({ onViolation() { overlay.innerHTML = 'count'; } });
    const el = dom.make();

    el.style.width = '1px';
    void el.offsetWidth;   // the real violation
    void el.offsetWidth;   // caused by the overlay write, and truthfully flagged

    assert.equal(p.summary().total, 2,
        'the overlay write is a real layout invalidation and must be reported');
});

test('I: ignorePatterns is the documented remedy for an overlay that writes', () => {
    const dom = installDom();
    const overlay = dom.make();
    const p = start({
        ignorePatterns: ['l99-9-extreme'],
        onViolation() { overlay.innerHTML = 'count'; }
    });
    const el = dom.make();

    el.style.width = '1px';
    void el.offsetWidth;
    void el.offsetWidth;

    assert.equal(p.summary().total, 0,
        'capture-time filtering removes the profiler own frames entirely');
});

test('I: a callback that destroys the profiler mid-record is survivable', () => {
    const dom = installDom();
    let p;
    p = start({ onViolation() { p.destroy(); } });
    const el = dom.make();

    el.style.width = '1px';
    assert.doesNotThrow(() => { void el.offsetWidth; });
    assert.equal(p.active, false);
    assert.doesNotThrow(() => p.summary());
    live = null;
});

test('I: a callback that resets mid-record leaves a coherent store', () => {
    const dom = installDom();
    let p;
    p = start({ onViolation() { p.reset(); } });
    const el = dom.make();

    el.style.width = '1px';
    void el.offsetWidth;

    const s = p.summary();
    assert.equal(s.total, 0, 'reset inside the callback clears the count it just made');
    assert.equal(s.stored, 0);
    assert.deepEqual(s.records, []);
});

test('I: a callback that reads the summary sees a coherent object', () => {
    const dom = installDom();
    let seen = null;
    let p;
    p = start({ onViolation() { seen = p.summary(); } });
    const el = dom.make();

    el.style.width = '1px';
    void el.offsetWidth;

    assert.ok(seen !== null);
    assert.equal(seen.total, 1);
    assert.equal(seen.records.length, 1);
    assert.equal(seen.cost.measured + seen.cost.unmeasured, 1);
});

test('I: a callback that gates its own summary does not deadlock or recurse', () => {
    const dom = installDom();
    let verdicts = 0;
    let p;
    p = start({
        onViolation() { if (!checkNoReflow(p.summary(), { maxReflows: 0 }).ok) verdicts++; }
    });
    const el = dom.make();
    for (let i = 0; i < 5; i++) {
        el.style.width = i + 'px';
        void el.offsetWidth;
    }
    assert.equal(verdicts, 5);
    assert.equal(p.summary().total, 5);
});

test('I: a non-function onViolation is ignored rather than called', () => {
    const dom = installDom();
    for (const bad of [42, 'cb', {}, []]) {
        const p = createLayoutProfiler({ warnToConsole: false, onViolation: bad });
        const el = dom.make();
        assert.doesNotThrow(() => {
            el.style.width = '1px';
            void el.offsetWidth;
        }, 'onViolation = ' + String(bad));
        p.destroy();
    }
});

test('I: a write inside a getter does not corrupt attribution of the outer read', () => {
    const dom = installDom();
    const p = start();
    const el = dom.make();
    const other = dom.make();

    Object.defineProperty(el, 'offsetHeight', {
        get() { other.style.height = '5px'; return 1; },
        configurable: true
    });

    el.style.width = '1px';
    void el.offsetHeight;
    assert.doesNotThrow(() => p.summary());
});

test('I: destroy during an open dirty window does not strand the flag', async () => {
    const dom = installDom();
    const p = start();
    const el = dom.make();

    el.style.width = '1px';     // dirty is set, checkpoint has not run
    p.destroy();
    live = null;
    await tick();

    const p2 = start();
    const el2 = dom.make();
    void el2.offsetWidth;       // clean read under a fresh profiler
    assert.equal(p2.summary().total, 0);
});

test('I: interleaved profilers do not see each other reflows', () => {
    const dom = installDom();
    const a = createLayoutProfiler({ warnToConsole: false });
    const el = dom.make();

    el.style.width = '1px';
    void el.offsetWidth;

    const b = createLayoutProfiler({ warnToConsole: false });
    el.style.width = '2px';
    void el.offsetWidth;

    assert.ok(a.summary().total >= 1);
    assert.equal(b.summary().total, 1, 'the newer profiler must not inherit history');
    b.destroy();
    a.destroy();
});

test('I: the host survives a callback that throws on every violation', () => {
    const dom = installDom();
    const before = snapshotProtos(dom.protos);
    const p = start({ onViolation() { throw new Error('always'); } });
    const el = dom.make();

    for (let i = 0; i < 20; i++) {
        try {
            el.style.width = i + 'px';
            void el.offsetWidth;
        } catch (e) { void e; }
    }
    p.destroy();
    live = null;
    assert.deepEqual(diffProtos(before, snapshotProtos(dom.protos)), [],
        'a hostile callback must not prevent a clean teardown');
});
