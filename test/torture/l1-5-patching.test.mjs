// L1.5 -- Patch integrity and hostile hosts. Axes E and F.
//
// This library is the only one in the ecosystem that mutates objects it does
// not own. Two failure modes follow from that and neither exists for a
// measurement-only profiler:
//
//   Axis E -- teardown must return the host bit-for-bit. A profiler that
//   leaves a wrapper behind has permanently slowed the page it was meant to
//   diagnose, and the next profiler to run will measure the leftovers.
//
//   Axis F -- the host may refuse to be patched. Frozen prototypes,
//   non-configurable descriptors, absent globals, accessors that throw. The
//   rule is that a torn patch net must never look like a clean run.

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

// ---------------------------------------------------------------------------
// Axis E -- teardown restores the host exactly
// ---------------------------------------------------------------------------

test('E: destroy restores every patched descriptor by identity', () => {
    const dom = installDom();
    const before = snapshotProtos(dom.protos);

    const p = start();
    const mid = snapshotProtos(dom.protos);
    assert.ok(diffProtos(before, mid).length > 0, 'the profiler must actually patch something');

    p.destroy();
    live = null;
    const after = snapshotProtos(dom.protos);
    const drift = diffProtos(before, after);
    assert.deepEqual(drift, [], 'teardown left the host changed:\n' + drift.join('\n'));
});

test('E: a full patch/destroy cycle repeated ten times leaves no residue', () => {
    const dom = installDom();
    const before = snapshotProtos(dom.protos);
    for (let i = 0; i < 10; i++) {
        const p = createLayoutProfiler({ warnToConsole: false });
        p.destroy();
    }
    assert.deepEqual(diffProtos(before, snapshotProtos(dom.protos)), [],
        'residue accumulated across cycles');
});

test('E: destroy is idempotent', () => {
    const dom = installDom();
    const before = snapshotProtos(dom.protos);
    const p = start();
    p.destroy();
    p.destroy();
    p.destroy();
    live = null;
    assert.deepEqual(diffProtos(before, snapshotProtos(dom.protos)), []);
});

test('E: after destroy the profiler records nothing and stays quiet', () => {
    const dom = installDom();
    const p = start();
    p.destroy();
    live = null;

    const el = dom.make();
    for (let i = 0; i < 50; i++) {
        el.style.width = i + 'px';
        void el.offsetWidth;
    }
    assert.equal(p.summary().total, 0);
    assert.equal(p.active, false);
    assert.deepEqual(p.violations, []);
});

test('E: nested profilers unwind in reverse order without residue', () => {
    const dom = installDom();
    const before = snapshotProtos(dom.protos);

    const outer = createLayoutProfiler({ warnToConsole: false });
    const inner = createLayoutProfiler({ warnToConsole: false });
    inner.destroy();
    outer.destroy();

    assert.deepEqual(diffProtos(before, snapshotProtos(dom.protos)), [],
        'LIFO teardown must restore the original');
});

test('E: destroying the outer profiler first is the documented hazard', () => {
    // Not a bug to fix, a property to pin: prototype patching is a stack, and
    // unwinding out of order restores an older layer over a newer one. The
    // test exists so the behaviour cannot change silently.
    const dom = installDom();
    const before = snapshotProtos(dom.protos);

    const outer = createLayoutProfiler({ warnToConsole: false });
    const inner = createLayoutProfiler({ warnToConsole: false });
    outer.destroy();
    const drift = diffProtos(before, snapshotProtos(dom.protos));
    assert.ok(drift.length > 0,
        'out-of-order teardown is expected to leave the inner patch installed');
    inner.destroy();
});

test('E: teardown survives a prototype frozen after patching', () => {
    const dom = installDom();
    const p = start();
    Object.freeze(dom.protos.HTMLElement.prototype);
    assert.doesNotThrow(() => p.destroy(), 'destroy must not throw on a frozen host');
    live = null;
});

test('E: teardown survives a foreign patch layered on top of ours', () => {
    const dom = installDom();
    const p = start();

    const d = Object.getOwnPropertyDescriptor(dom.protos.HTMLElement.prototype, 'offsetWidth');
    Object.defineProperty(dom.protos.HTMLElement.prototype, 'offsetWidth', {
        get() { return d.get.call(this); }, set: d.set, configurable: true
    });

    assert.doesNotThrow(() => p.destroy());
    live = null;
});

// ---------------------------------------------------------------------------
// Axis F -- hostile hosts
// ---------------------------------------------------------------------------

test('F: a frozen prototype does not crash the constructor', () => {
    installDom({ freeze: ['HTMLElement'] });
    assert.doesNotThrow(() => start(),
        'a host that refuses patching must degrade, not throw');
});

test('F: a frozen read prototype cannot report a clean run', () => {
    const dom = installDom({ freeze: ['HTMLElement'] });
    const p = start();
    const el = dom.make();
    el.style.width = '1px';
    void el.offsetWidth;      // undetectable: the getter was never patched

    const rep = checkNoReflow(p.summary(), { maxReflows: 0 });
    assert.equal(rep.ok, false,
        'zero reflows through a torn patch net is not a clean run');
    assert.equal(rep.verified, false);
});

test('F: every prototype frozen at once still yields a usable profiler', () => {
    installDom({ freeze: ['Node', 'Element', 'HTMLElement', 'CSSStyleDeclaration'] });
    const p = start();
    assert.doesNotThrow(() => p.summary());
    assert.doesNotThrow(() => p.destroy());
    live = null;
});

test('F: non-configurable descriptors are skipped, not thrown over', () => {
    installDom({
        nonConfigurable: [
            'HTMLElement.offsetWidth',
            'Element.className',
            'CSSStyleDeclaration.width'
        ]
    });
    assert.doesNotThrow(() => start());
    const rep = checkNoReflow(live.summary(), { maxReflows: 0 });
    assert.equal(rep.verified, false, 'partial coverage must be visible to the gate');
});

test('F: missing optional globals are tolerated one at a time', () => {
    for (const omit of ['CSSStyleDeclaration', 'Node', 'window']) {
        installDom({ omit: [omit] });
        assert.doesNotThrow(() => {
            const p = createLayoutProfiler({ warnToConsole: false });
            p.summary();
            p.destroy();
        }, 'omitting ' + omit);
        removeDom();
    }
});

test('F: no Element at all yields the no-op profiler, not a crash', () => {
    installDom({ omit: ['Element', 'HTMLElement'] });
    const p = start();
    assert.equal(p.active, false);
    const s = p.summary();
    assert.equal(s.total, 0);
    assert.equal(s.cost.resolutionMs, null);
    assert.doesNotThrow(() => checkNoReflow(s, { maxReflows: 0 }));
});

test('F: a getter that throws propagates and does not wedge the profiler', () => {
    const dom = installDom({ throwOnRead: true });
    const p = start();
    const el = dom.make();

    el.style.width = '1px';
    assert.throws(() => { void el.offsetWidth; }, /hostile offsetWidth/);

    // The profiler must still be usable afterwards.
    assert.doesNotThrow(() => p.summary());
    assert.equal(p.active, true);
});

test('F: a write setter that throws does not leave a permanent dirty flag', async () => {
    const dom = installDom({ throwOnWrite: true });
    const p = start();
    const el = dom.make();

    assert.throws(() => { el.style.width = '1px'; }, /hostile style.width/);
    await new Promise((r) => queueMicrotask(r));

    // The microtask checkpoint clears whatever the failed write set.
    void el.offsetWidth;
    assert.equal(p.summary().total, 0,
        'a clean read after a failed write must not be flagged');
});

test('F: a foreign patch installed before ours is still measured through', () => {
    const dom = installDom({ foreignPatch: true });
    const p = start();
    const el = dom.make();

    el.style.width = '1px';
    void el.offsetWidth;

    assert.equal(p.summary().total, 1, 'our patch must sit on top of the foreign one');
    assert.ok(dom.foreignReads > 0, 'the foreign patch must still run');
});

test('F: patching twice over the same prototype does not double-count', () => {
    const dom = installDom();
    const a = createLayoutProfiler({ warnToConsole: false });
    const b = createLayoutProfiler({ warnToConsole: false });
    const el = dom.make();

    el.style.width = '1px';
    void el.offsetWidth;

    // Each profiler sees the reflow once; neither sees it twice.
    assert.equal(a.summary().total <= 1, true, 'outer profiler over-counted');
    assert.equal(b.summary().total, 1, 'inner profiler must see exactly one');

    b.destroy();
    a.destroy();
});

test('F: an element whose prototype chain is replaced mid-run is inert', () => {
    const dom = installDom();
    const p = start();
    const el = dom.make();

    Object.setPrototypeOf(el, Object.create(null));
    assert.doesNotThrow(() => { void el.offsetWidth; });
    assert.equal(p.summary().total, 0);
});

test('F: window without getComputedStyle does not break patching', () => {
    installDom();
    delete globalThis.window.getComputedStyle;
    assert.doesNotThrow(() => start());
    assert.doesNotThrow(() => live.destroy());
    live = null;
});

test('F: a prototype with no layout getters at all patches to nothing', () => {
    installDom({
        nonConfigurable: [
            'HTMLElement.offsetWidth', 'HTMLElement.offsetHeight',
            'HTMLElement.offsetTop', 'HTMLElement.offsetLeft',
            'HTMLElement.clientWidth', 'HTMLElement.clientHeight',
            'HTMLElement.clientTop', 'HTMLElement.clientLeft',
            'HTMLElement.scrollWidth', 'HTMLElement.scrollHeight',
            'HTMLElement.scrollTop', 'HTMLElement.scrollLeft'
        ]
    });
    const p = start();
    const s = p.summary();
    assert.equal(s.total, 0);
    assert.equal(checkNoReflow(s, { maxReflows: 0 }).verified, false,
        'a profiler that patched no reads must not certify anything');
});
