// Cost lane (v1.2), gate semantics. Pure functions over synthetic summaries.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkNoReflow, assertNoReflow } from '../LayoutProfiler.js';

let nextId = 0;
function rec(over) {
    nextId++;
    return Object.assign({
        id: nextId,
        taskId: 0,
        read: 'offsetWidth',
        write: 'CSSStyleDeclaration.width =',
        readSite: '  at updateSize (app.js:42:12)',
        writeSite: '  at resizeHandler (app.js:38:5)',
        costMs: 1,
        belowGranularity: false,
        timestamp: 0
    }, over);
}

function sum(records, over) {
    const byRead = {}, byWrite = {}, byTask = {};
    const costs = [];
    let unmeasured = 0;
    for (const r of records) {
        byRead[r.read] = (byRead[r.read] || 0) + 1;
        byWrite[r.write] = (byWrite[r.write] || 0) + 1;
        byTask[r.taskId] = (byTask[r.taskId] || 0) + 1;
        if (typeof r.costMs === 'number') costs.push(r.costMs); else unmeasured++;
    }
    const measured = costs.length;
    const totalMs = costs.reduce((a, b) => a + b, 0);
    return Object.assign({
        total: records.length,
        stored: records.length,
        truncated: false,
        stacks: true,
        byRead, byWrite, byTask,
        taskCount: Object.keys(byTask).length,
        cost: {
            resolutionMs: 0.1,
            measured,
            unmeasured,
            totalMs: measured > 0 ? totalMs : null,
            maxMs: measured > 0 ? Math.max(...costs) : null,
            avgMs: measured > 0 ? totalMs / measured : null,
            p99Ms: measured > 0 ? Math.max(...costs) : null
        },
        records
    }, over);
}

// --- maxCostMs -------------------------------------------------------------

test('maxCostMs passes when the worst stall is under the limit', () => {
    const s = sum([rec({ costMs: 1.2 }), rec({ costMs: 3.4 })]);
    const r = checkNoReflow(s, { maxReflows: 99, maxCostMs: 4 });
    assert.equal(r.ok, true);
    assert.equal(r.cost.maxMs, 3.4);
});

test('maxCostMs fails on the worst single stall and names its site', () => {
    const s = sum([
        rec({ costMs: 1 }),
        rec({ costMs: 9.5, readSite: '  at layoutPass (grid.js:88:4)' })
    ]);
    const r = checkNoReflow(s, { maxReflows: 99, maxCostMs: 4 });
    assert.equal(r.ok, false);
    const v = r.violations.find((x) => x.metric === 'maxCostMs');
    assert.equal(v.limit, 4);
    assert.equal(v.actual, 9.5);
    assert.match(v.reason, /9\.500 ms/);
    assert.match(v.reason, /grid\.js:88:4/);
});

test('maxTotalCostMs sums measured stalls', () => {
    const s = sum([rec({ costMs: 2 }), rec({ costMs: 3 }), rec({ costMs: 4 })]);
    assert.equal(checkNoReflow(s, { maxReflows: 99, maxTotalCostMs: 9 }).ok, true);
    const r = checkNoReflow(s, { maxReflows: 99, maxTotalCostMs: 8 });
    assert.equal(r.ok, false);
    assert.equal(r.violations[0].metric, 'maxTotalCostMs');
    assert.equal(r.violations[0].actual, 9);
});

test('a run can breach one budget while a whole frame is still cheap', () => {
    // 12 ms total is fine for a long task; a single 12 ms stall is not.
    const s = sum([rec({ costMs: 12 })]);
    const r = checkNoReflow(s, { maxReflows: 99, maxCostMs: 4, maxTotalCostMs: 16 });
    assert.deepEqual(r.violations.map((v) => v.metric), ['maxCostMs']);
});

// --- fail-closed on unmeasured --------------------------------------------

test('unmeasured reflows make cost rules unverifiable, never passing', () => {
    // Summing nulls as zeroes would let a thousand sub-resolution stalls
    // slide under a millisecond budget.
    const s = sum([
        rec({ costMs: 0.5 }),
        rec({ costMs: null, belowGranularity: true })
    ]);
    const r = checkNoReflow(s, { maxReflows: 99, maxTotalCostMs: 100 });
    assert.equal(r.ok, false);
    assert.equal(r.verified, false);
    const v = r.violations.find((x) => x.metric === 'cost');
    assert.match(v.reason, /1 of 2 counted reflows carry no cost/);
    assert.match(v.reason, /below the 0\.1 ms timer resolution/);
});

test('unknown timer resolution is reported as such, not as a small number', () => {
    const s = sum([rec({ costMs: null })], {
        cost: { resolutionMs: null, measured: 0, unmeasured: 1,
            totalMs: null, maxMs: null, avgMs: null, p99Ms: null }
    });
    const r = checkNoReflow(s, { maxReflows: 99, maxCostMs: 4 });
    assert.equal(r.verified, false);
    assert.match(r.violations[0].reason, /timer resolution could not be determined/);
});

test('unmeasured reflows do not block rules that need no cost', () => {
    const s = sum([rec({ costMs: null }), rec({ costMs: null })]);
    const r = checkNoReflow(s, { maxReflows: 5, maxPerTask: 5 });
    assert.equal(r.ok, true);
    assert.equal(r.verified, true);
});

test('a pre-1.2 summary has no costMs and fails cost rules', () => {
    const legacy = {
        total: 1, stored: 1, truncated: false, stacks: true,
        byRead: {}, byWrite: {}, byTask: { 0: 1 }, taskCount: 1,
        records: [{
            id: 1, taskId: 0, read: 'offsetWidth', write: 'x',
            readSite: 'a', writeSite: 'b', timestamp: 0
        }]
    };
    const r = checkNoReflow(legacy, { maxReflows: 9, maxCostMs: 4 });
    assert.equal(r.verified, false);
    assert.equal(r.violations[0].metric, 'cost');
});

test('truncation blocks cost rules too', () => {
    const s = sum([], { total: 900, stored: 0, truncated: true });
    const r = checkNoReflow(s, { maxReflows: 1000, maxCostMs: 4 });
    assert.equal(r.verified, false);
    assert.equal(r.violations[0].metric, 'records');
});

// --- exclusions interact with cost ----------------------------------------

test('an allowlisted stall costs nothing against the budget', () => {
    const s = sum([
        rec({ costMs: 20, read: 'getBoundingClientRect()' }),
        rec({ costMs: 1, read: 'offsetWidth' })
    ]);
    const r = checkNoReflow(s, {
        maxReflows: 99, maxCostMs: 4,
        allowReads: ['getBoundingClientRect']
    });
    assert.equal(r.ok, true);
    assert.equal(r.cost.measured, 1);
    assert.equal(r.cost.maxMs, 1);
});

test('excluding the only unmeasured record restores verifiability', () => {
    const s = sum([
        rec({ costMs: null, readSite: '  at tick (node_modules/gsap/x.js:1:1)' }),
        rec({ costMs: 2 })
    ]);
    const r = checkNoReflow(s, {
        maxReflows: 99, maxTotalCostMs: 5, ignoreSites: ['node_modules/gsap']
    });
    assert.equal(r.verified, true);
    assert.equal(r.ok, true);
});

// --- report shape ----------------------------------------------------------

test('report carries a cost block whenever records were available', () => {
    const r = checkNoReflow(sum([rec({ costMs: 2 }), rec({ costMs: null })]));
    assert.equal(r.cost.measured, 1);
    assert.equal(r.cost.unmeasured, 1);
    assert.equal(r.cost.totalMs, 2);
});

test('report cost totals are null, not zero, when nothing was measured', () => {
    const r = checkNoReflow(sum([rec({ costMs: null })]), { maxReflows: 9 });
    assert.equal(r.cost.measured, 0);
    assert.equal(r.cost.totalMs, null);
    assert.equal(r.cost.maxMs, null);
});

test('report cost is null when no records were supplied at all', () => {
    const legacy = { total: 3, stored: 3, byRead: {}, byWrite: {} };
    assert.equal(checkNoReflow(legacy, { maxReflows: 9 }).cost, null);
});

// --- validation ------------------------------------------------------------

test('cost rule values are type-checked', () => {
    assert.throws(() => checkNoReflow(sum([]), { maxCostMs: -1 }), TypeError);
    assert.throws(() => checkNoReflow(sum([]), { maxTotalCostMs: '4ms' }), TypeError);
});

test('a misspelled cost rule suggests the right one', () => {
    assert.throws(
        () => checkNoReflow(sum([]), { maxCostMS: 4 }),
        (e) => /Did you mean `maxCostMs`\?/.test(e.message)
    );
});

test('assertNoReflow throws on a cost breach', () => {
    assert.throws(
        () => assertNoReflow(sum([rec({ costMs: 30 })]), { maxReflows: 9, maxCostMs: 4 }),
        (e) => e.name === 'ReflowBudgetError' && /30\.000 ms/.test(e.message)
    );
});
