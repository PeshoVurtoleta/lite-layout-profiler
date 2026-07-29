// Expected-scope lane (v1.5). profiler.expected(fn) marks a synchronous region
// as a deliberate-measurement zone; reflows inside it are stamped expected, and
// allowExpected excuses them by DYNAMIC SCOPE -- so the same read is allowed
// where you meant it and still fails elsewhere. Adversarial cases in
// test/torture/l5-5-expected.test.mjs.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

let win;
let profiler = null;

beforeEach(() => {
    win = new Window();
    globalThis.window = win;
    globalThis.document = win.document;
    globalThis.Node = win.Node;
    globalThis.Element = win.Element;
    globalThis.HTMLElement = win.HTMLElement;
    globalThis.CSSStyleDeclaration = win.CSSStyleDeclaration;
});
afterEach(() => {
    if (profiler) { try { profiler.destroy(); } catch (e) { void e; } profiler = null; }
    delete globalThis.window; delete globalThis.document; delete globalThis.Node;
    delete globalThis.Element; delete globalThis.HTMLElement; delete globalThis.CSSStyleDeclaration;
});

async function start(opts) {
    const { createLayoutProfiler } = await import('../LayoutProfiler.js');
    profiler = createLayoutProfiler(Object.assign({ warnToConsole: false }, opts));
    return profiler;
}
function el() {
    const e = win.document.createElement('div');
    win.document.body.appendChild(e);
    return e;
}
function reflow(node) { node.style.width = (Math.random() * 100) + 'px'; void node.offsetWidth; }

// ---------------------------------------------------------------------------
// stamping
// ---------------------------------------------------------------------------

test('a reflow inside expected() is stamped expected, one outside is not', async () => {
    const p = await start();
    const node = el();
    p.expected(() => reflow(node));
    reflow(node);
    const s = p.summary();
    assert.equal(s.total, 2);
    assert.equal(s.expected, 1);
    assert.deepEqual(s.records.map((r) => r.expected), [true, false]);
});

test('expected() returns its callback value', async () => {
    const p = await start();
    const out = p.expected(() => 42);
    assert.equal(out, 42);
});

test('expected scopes nest, and depth restores between them', async () => {
    const p = await start();
    const node = el();
    p.expected(() => {
        reflow(node);                     // expected (depth 1)
        p.expected(() => reflow(node));   // expected (depth 2)
    });
    reflow(node);                         // NOT expected (depth 0)
    const s = p.summary();
    assert.equal(s.expected, 2);
    assert.equal(s.records.filter((r) => !r.expected).length, 1);
});

test('a throw inside expected() still restores the scope', async () => {
    const p = await start();
    const node = el();
    assert.throws(() => p.expected(() => { reflow(node); throw new Error('boom'); }), /boom/);
    // The next reflow, outside, must NOT be expected -- depth was restored.
    reflow(node);
    const s = p.summary();
    assert.equal(s.records[s.records.length - 1].expected, false,
        'depth restored in finally after the throw');
});

test('an await inside expected() escapes the scope (synchronous only)', async () => {
    const p = await start();
    const node = el();
    await p.expected(async () => {
        reflow(node);                 // synchronous part -> expected
        await Promise.resolve();
        reflow(node);                 // after await -> a new task, NOT expected
    });
    const s = p.summary();
    // Exactly one expected: the synchronous read before the await.
    assert.equal(s.expected, 1, 'only the pre-await read is inside the sync scope');
});

// ---------------------------------------------------------------------------
// gate exclusion
// ---------------------------------------------------------------------------

test('allowExpected excuses in-scope reflows but not out-of-scope ones', async () => {
    const { checkNoReflow } = await import('../LayoutProfiler.js');
    const p = await start();
    const node = el();
    p.expected(() => reflow(node));   // deliberate
    reflow(node);                     // accidental
    const rep = checkNoReflow(p.summary(), { maxReflows: 0, allowExpected: true });
    assert.equal(rep.ok, false, 'the accidental reflow still fails');
    assert.equal(rep.counted, 1);
    assert.equal(rep.excludedBy.expected, 1);
});

test('the SAME read name is allowed in-scope and fails out-of-scope', async () => {
    const { checkNoReflow } = await import('../LayoutProfiler.js');
    const p = await start();
    const node = el();
    // offsetWidth in both places -- allowReads would silence both; allowExpected
    // silences only the deliberate one.
    p.expected(() => { node.style.width = '10px'; void node.offsetWidth; });
    node.style.height = '5px'; void node.offsetWidth;
    const rep = checkNoReflow(p.summary(), { maxReflows: 0, allowExpected: true });
    assert.equal(rep.counted, 1, 'the same read name still fails outside the scope');
});

test('without allowExpected, expected reflows count normally', async () => {
    const { checkNoReflow } = await import('../LayoutProfiler.js');
    const p = await start();
    const node = el();
    p.expected(() => reflow(node));
    const rep = checkNoReflow(p.summary(), { maxReflows: 0 });
    assert.equal(rep.ok, false, 'the label is inert until a gate opts in');
    assert.equal(rep.counted, 1);
    assert.equal(rep.excludedBy.expected, 0);
});

test('allowExpected combines with allowReads without double-excluding', async () => {
    const { checkNoReflow } = await import('../LayoutProfiler.js');
    const p = await start();
    const node = el();
    // A reflow both inside expected() AND matching allowReads: excluded once.
    p.expected(() => reflow(node));
    const rep = checkNoReflow(p.summary(), {
        maxReflows: 0, allowExpected: true, allowReads: ['offsetWidth']
    });
    assert.equal(rep.excluded, 1, 'excluded once, not twice');
    // The identity rule (reads) is checked first, so it claims the exclusion.
    assert.equal(rep.excludedBy.reads, 1);
    assert.equal(rep.excludedBy.expected, 0);
});

// ---------------------------------------------------------------------------
// fail-closed
// ---------------------------------------------------------------------------

test('allowExpected on a pre-1.5 summary is unverifiable, not a silent pass', async () => {
    const { checkNoReflow } = await import('../LayoutProfiler.js');
    // A record without the `expected` field (a pre-1.5 build's shape).
    const legacy = {
        total: 1, stored: 1, truncated: false, stacks: true,
        patched: { applied: 1, failed: 0, skipped: 0, foreign: 0, complete: true, provenance: {}, failures: [] },
        records: [{
            id: 1, taskId: 0, read: 'offsetWidth', write: 'x =',
            readSite: 'a', writeSite: 'b', phase: 'unobserved', roFeedback: false,
            costMs: null, belowGranularity: false, timestamp: 0
            // no `expected` field
        }]
    };
    const rep = checkNoReflow(legacy, { maxReflows: 0, allowExpected: true });
    assert.equal(rep.verified, false, 'cannot honour an expected exclusion without the flag');
    assert.equal(rep.ok, false);
});

test('allowExpected must be a boolean', async () => {
    const { checkNoReflow } = await import('../LayoutProfiler.js');
    const p = await start();
    assert.throws(() => checkNoReflow(p.summary(), { allowExpected: 'yes' }), TypeError);
    assert.throws(() => checkNoReflow(p.summary(), { allowExpected: 1 }), TypeError);
});

test('expected(fn) rejects a non-function', async () => {
    const p = await start();
    assert.throws(() => p.expected(42), TypeError);
    assert.throws(() => p.expected(), TypeError);
});

test('a summary round-trips through JSON and still excuses expected reflows', async () => {
    const { checkNoReflow } = await import('../LayoutProfiler.js');
    const p = await start();
    const node = el();
    p.expected(() => reflow(node));
    reflow(node);
    const wire = JSON.parse(JSON.stringify(p.summary()));
    const rep = checkNoReflow(wire, { maxReflows: 0, allowExpected: true });
    assert.equal(rep.counted, 1);
    assert.equal(rep.excludedBy.expected, 1);
});
