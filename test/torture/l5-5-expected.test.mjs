// L5.5 -- Torture for the expected-scope lane (v1.5). The lane makes a scoped
// exclusion possible, so the danger is symmetric with the allowlist: a reflow
// must be excused ONLY where deliberate (a false exclusion hides a real bug),
// and the scope must be exactly the synchronous region marked (a leaked scope
// excuses reflows the developer never meant). Axes:
//
//   A -- scope boundaries: expected iff inside the sync region, never outside,
//        never leaked across a throw or an await.
//   B -- gate exclusion is scoped, not identity: same read allowed in, failed
//        out; excluded once when it overlaps another allowlist rule.
//   C -- fail-closed: allowExpected without the flag is unverifiable; the label
//        is inert until a gate opts in; type validation.
//   D -- nesting and accounting self-consistency.

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
    const { createLayoutProfiler } = await import('../../LayoutProfiler.js');
    profiler = createLayoutProfiler(Object.assign({ warnToConsole: false }, opts));
    return profiler;
}
async function gate() { return (await import('../../LayoutProfiler.js')).checkNoReflow; }
function el() {
    const e = win.document.createElement('div');
    win.document.body.appendChild(e);
    return e;
}
function reflow(node) { node.style.width = (Math.random() * 100) + 'px'; void node.offsetWidth; }

// =============================================================================
// AXIS A -- scope boundaries
// =============================================================================

test('[A] a reflow immediately before and after expected() is not expected', async () => {
    const p = await start();
    const node = el();
    reflow(node);                     // before
    p.expected(() => reflow(node));   // inside
    reflow(node);                     // after
    const flags = p.summary().records.map((r) => r.expected);
    assert.deepEqual(flags, [false, true, false], 'the scope is exactly the callback');
});

test('[A] a throw does not leak the scope to later reflows', async () => {
    const p = await start();
    const node = el();
    try { p.expected(() => { reflow(node); throw new Error('x'); }); } catch (e) { void e; }
    reflow(node);
    reflow(node);
    const after = p.summary().records.slice(1);   // everything after the in-scope one
    assert.ok(after.every((r) => r.expected === false), 'depth restored, no leak');
});

test('[A] a nested throw only unwinds one level', async () => {
    const p = await start();
    const node = el();
    p.expected(() => {
        try { p.expected(() => { throw new Error('inner'); }); } catch (e) { void e; }
        // We are still at depth 1 here -- the inner throw unwound only its level.
        reflow(node);   // expected
    });
    reflow(node);       // not expected
    const s = p.summary();
    assert.equal(s.expected, 1);
    assert.equal(s.records[s.records.length - 1].expected, false);
});

test('[A] an await inside expected() escapes; post-await reflow is not expected', async () => {
    const p = await start();
    const node = el();
    await p.expected(async () => {
        reflow(node);              // sync -> expected
        await Promise.resolve();
        reflow(node);              // post-await -> escaped
    });
    assert.equal(p.summary().expected, 1);
});

test('[A] scope is inert with no reflows -- expected() of a pure function records nothing', async () => {
    const p = await start();
    const out = p.expected(() => 7);
    assert.equal(out, 7);
    assert.equal(p.summary().total, 0);
    assert.equal(p.summary().expected, 0);
});

// =============================================================================
// AXIS B -- exclusion is scoped, not identity
// =============================================================================

test('[B] same read: excused in-scope, failed out-of-scope', async () => {
    const check = await gate();
    const p = await start();
    const node = el();
    p.expected(() => { node.style.width = '1px'; void node.offsetWidth; });
    node.style.height = '1px'; void node.offsetWidth;
    const rep = check(p.summary(), { maxReflows: 0, allowExpected: true });
    assert.equal(rep.counted, 1);
    assert.equal(rep.excludedBy.expected, 1);
});

test('[B] a reflow overlapping expected AND allowReads is excluded exactly once', async () => {
    const check = await gate();
    const p = await start();
    const node = el();
    p.expected(() => reflow(node));
    const rep = check(p.summary(), { maxReflows: 0, allowExpected: true, allowReads: ['offsetWidth'] });
    assert.equal(rep.excluded, 1);
    // Identity rule wins the attribution; expected does not double-count.
    assert.equal(rep.excludedBy.reads + rep.excludedBy.expected, 1);
});

test('[B] allowExpected does not excuse an out-of-scope reflow that matches nothing', async () => {
    const check = await gate();
    const p = await start();
    const node = el();
    reflow(node); reflow(node);   // both outside any scope
    const rep = check(p.summary(), { maxReflows: 0, allowExpected: true });
    assert.equal(rep.counted, 2, 'nothing was in scope, so nothing is excused');
    assert.equal(rep.excludedBy.expected, 0);
});

test('[B] maxReflows reason notes the exclusions', async () => {
    const check = await gate();
    const p = await start();
    const node = el();
    p.expected(() => reflow(node));
    reflow(node);
    const rep = check(p.summary(), { maxReflows: 0, allowExpected: true });
    assert.ok(!rep.ok);
    assert.match(rep.violations[0].reason, /excluded/);
});

// =============================================================================
// AXIS C -- fail-closed
// =============================================================================

test('[C] allowExpected without the record flag is unverifiable', async () => {
    const check = await gate();
    const legacy = {
        total: 1, stored: 1, truncated: false, stacks: true,
        patched: { applied: 1, failed: 0, skipped: 0, foreign: 0, complete: true, provenance: {}, failures: [] },
        records: [{
            id: 1, taskId: 0, read: 'offsetWidth', write: 'x =', readSite: 'a', writeSite: 'b',
            phase: 'unobserved', roFeedback: false, costMs: null, belowGranularity: false, timestamp: 0
        }]
    };
    const rep = check(legacy, { maxReflows: 0, allowExpected: true });
    assert.equal(rep.verified, false);
    assert.equal(rep.ok, false);
});

test('[C] the label is inert without allowExpected', async () => {
    const check = await gate();
    const p = await start();
    const node = el();
    p.expected(() => reflow(node));
    const rep = check(p.summary(), { maxReflows: 0 });
    assert.equal(rep.counted, 1, 'expected reflows count normally when the gate does not opt in');
    assert.equal(rep.excludedBy.expected, 0);
});

test('[C] allowExpected: false is the same as omitting it', async () => {
    const check = await gate();
    const p = await start();
    const node = el();
    p.expected(() => reflow(node));
    const a = check(p.summary(), { maxReflows: 0, allowExpected: false });
    const b = check(p.summary(), { maxReflows: 0 });
    assert.equal(a.counted, b.counted);
    assert.equal(a.excludedBy.expected, 0);
});

test('[C] a non-boolean allowExpected throws', async () => {
    const check = await gate();
    const p = await start();
    assert.throws(() => check(p.summary(), { allowExpected: 'yes' }), TypeError);
    assert.throws(() => check(p.summary(), { allowExpected: 0 }), TypeError);
    assert.throws(() => check(p.summary(), { allowExpected: null }), TypeError);
});

test('[C] expected(fn) rejects non-functions', async () => {
    const p = await start();
    assert.throws(() => p.expected(), TypeError);
    assert.throws(() => p.expected('nope'), TypeError);
    assert.throws(() => p.expected({}), TypeError);
});

// =============================================================================
// AXIS D -- nesting and accounting
// =============================================================================

test('[D] deep nesting stays expected throughout and restores fully', async () => {
    const p = await start();
    const node = el();
    p.expected(() => p.expected(() => p.expected(() => p.expected(() => reflow(node)))));
    reflow(node);
    const s = p.summary();
    assert.equal(s.expected, 1);
    assert.equal(s.records[s.records.length - 1].expected, false, 'four levels unwound cleanly');
});

test('[D] summary.expected equals the count of expected records', async () => {
    const p = await start();
    const node = el();
    p.expected(() => { reflow(node); reflow(node); });
    reflow(node);
    const s = p.summary();
    const flagged = s.records.filter((r) => r.expected).length;
    assert.equal(s.expected, flagged);
});

test('[D] counted + excluded equals total under allowExpected', async () => {
    const check = await gate();
    const p = await start();
    const node = el();
    p.expected(() => { reflow(node); reflow(node); });
    reflow(node);
    const rep = check(p.summary(), { maxReflows: 0, allowExpected: true });
    assert.equal(rep.counted + rep.excluded, rep.total);
    assert.equal(rep.excluded, 2);
    assert.equal(rep.counted, 1);
});

test('[D] reset clears the expected count', async () => {
    const p = await start();
    const node = el();
    p.expected(() => reflow(node));
    assert.equal(p.summary().expected, 1);
    p.reset();
    assert.equal(p.summary().expected, 0);
    assert.equal(p.summary().total, 0);
});
