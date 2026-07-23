// Gate lane (v1.1). Pure-function tests over synthetic summaries -- no DOM
// required, so these run identically in node and in CI without happy-dom.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    checkNoReflow,
    assertNoReflow,
    ReflowBudgetError,
    READ_NAMES
} from '../LayoutProfiler.js';

// --- helpers ---------------------------------------------------------------

let nextId = 0;
function rec(over) {
    nextId++;
    return Object.assign({
        id: nextId,
        taskId: 0,
        read: 'offsetWidth',
        write: 'CSSStyleDeclaration.setProperty()',
        readSite: '  at updateSize (app.js:42:12)',
        writeSite: '  at resizeHandler (app.js:38:5)',
        timestamp: 0
    }, over);
}

function sum(records, over) {
    const byRead = {}, byWrite = {}, byTask = {};
    for (const r of records) {
        byRead[r.read] = (byRead[r.read] || 0) + 1;
        byWrite[r.write] = (byWrite[r.write] || 0) + 1;
        byTask[r.taskId] = (byTask[r.taskId] || 0) + 1;
    }
    return Object.assign({
        total: records.length,
        stored: records.length,
        truncated: false,
        stacks: true,
        byRead, byWrite, byTask,
        taskCount: Object.keys(byTask).length,
        records
    }, over);
}

// --- default budget --------------------------------------------------------

test('clean run passes the default zero budget', () => {
    const r = checkNoReflow(sum([]));
    assert.equal(r.ok, true);
    assert.equal(r.verified, true);
    assert.equal(r.counted, 0);
    assert.deepEqual(r.violations, []);
});

test('default budget is zero: one reflow fails', () => {
    const r = checkNoReflow(sum([rec()]));
    assert.equal(r.ok, false);
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].metric, 'maxReflows');
    assert.equal(r.violations[0].limit, 0);
    assert.equal(r.violations[0].actual, 1);
});

test('maxReflows tolerates up to the limit and fails past it', () => {
    const three = [rec(), rec(), rec()];
    assert.equal(checkNoReflow(sum(three), { maxReflows: 3 }).ok, true);
    assert.equal(checkNoReflow(sum(three), { maxReflows: 2 }).ok, false);
});

test('gate report keeps the checkNoGc violation shape', () => {
    const r = checkNoReflow(sum([rec()]));
    const v = r.violations[0];
    for (const k of ['metric', 'limit', 'actual', 'reason']) {
        assert.ok(k in v, 'missing key: ' + k);
    }
    assert.equal(typeof v.reason, 'string');
});

// --- unknown keys / did-you-mean ------------------------------------------

test('unknown rule key throws with a did-you-mean hint', () => {
    assert.throws(
        () => checkNoReflow(sum([]), { maxReflow: 0 }),
        (e) => e instanceof TypeError &&
            /Unknown gate rule `maxReflow`/.test(e.message) &&
            /Did you mean `maxReflows`\?/.test(e.message)
    );
});

test('case-only typo resolves to the exact key', () => {
    assert.throws(
        () => checkNoReflow(sum([]), { MaxPerTask: 1 }),
        (e) => /Did you mean `maxPerTask`\?/.test(e.message)
    );
});

test('unrelated key throws without a bogus suggestion', () => {
    assert.throws(
        () => checkNoReflow(sum([]), { bananas: 1 }),
        (e) => /Unknown gate rule `bananas`/.test(e.message) &&
            !/Did you mean/.test(e.message)
    );
});

test('future-lane rules name the lane instead of guessing a spelling', () => {
    assert.throws(
        () => checkNoReflow(sum([]), { maxCostMs: 4 }),
        (e) => /requires the cost lane \(v1\.2\+\)/.test(e.message)
    );
    assert.throws(
        () => checkNoReflow(sum([]), { maxInRaf: 0 }),
        (e) => /requires the phase lane \(v1\.3\+\)/.test(e.message)
    );
});

test('rule values are type-checked', () => {
    assert.throws(() => checkNoReflow(sum([]), { maxReflows: -1 }), TypeError);
    assert.throws(() => checkNoReflow(sum([]), { maxReflows: 'zero' }), TypeError);
    assert.throws(() => checkNoReflow(sum([]), { maxReflows: Infinity }), TypeError);
    assert.throws(() => checkNoReflow(sum([]), { allowReads: 'offsetWidth' }), TypeError);
    assert.throws(() => checkNoReflow(sum([]), { allowReads: [42] }), TypeError);
});

test('summary itself is validated', () => {
    assert.throws(() => checkNoReflow(null), TypeError);
    assert.throws(() => checkNoReflow('summary'), TypeError);
});

// --- allowlists ------------------------------------------------------------

test('allowReads excludes by read name and reports the subtraction', () => {
    const s = sum([
        rec({ read: 'offsetWidth' }),
        rec({ read: 'offsetWidth' }),
        rec({ read: 'clientHeight' })
    ]);
    const r = checkNoReflow(s, { allowReads: ['offsetWidth'], maxReflows: 1 });
    assert.equal(r.excluded, 2);
    assert.equal(r.excludedBy.reads, 2);
    assert.equal(r.counted, 1);
    assert.equal(r.ok, true);
});

test('allowReads accepts a method name with or without parens', () => {
    const s = sum([rec({ read: 'getBoundingClientRect()' })]);
    assert.equal(checkNoReflow(s, { allowReads: ['getBoundingClientRect'] }).counted, 0);
    assert.equal(checkNoReflow(s, { allowReads: ['getBoundingClientRect()'] }).counted, 0);
});

test('allowReads rejects a name outside the read vocabulary', () => {
    assert.throws(
        () => checkNoReflow(sum([]), { allowReads: ['offsetWidht'] }),
        (e) => e instanceof TypeError &&
            /not a read this build can emit/.test(e.message) &&
            /Did you mean `offsetWidth`\?/.test(e.message)
    );
});

test('every READ_NAMES entry is accepted by allowReads', () => {
    assert.doesNotThrow(() => checkNoReflow(sum([]), { allowReads: READ_NAMES.slice() }));
});

test('allowWrites is a prefix match', () => {
    const s = sum([
        rec({ write: 'CSSStyleDeclaration.width =' }),
        rec({ write: 'CSSStyleDeclaration.setProperty()' }),
        rec({ write: 'Element.className =' })
    ]);
    const r = checkNoReflow(s, { allowWrites: ['CSSStyleDeclaration.'], maxReflows: 1 });
    assert.equal(r.excludedBy.writes, 2);
    assert.equal(r.counted, 1);
    assert.equal(r.ok, true);
});

test('ignoreSites matches either call site', () => {
    const s = sum([
        rec({ readSite: '  at tick (node_modules/gsap/gsap-core.js:9:1)' }),
        rec({ writeSite: '  at flip (node_modules/gsap/Flip.js:3:1)' }),
        rec()
    ]);
    const r = checkNoReflow(s, { ignoreSites: ['node_modules/gsap'] });
    assert.equal(r.excludedBy.sites, 2);
    assert.equal(r.counted, 1);
    assert.equal(r.ok, false);
});

test('a record is excluded once even when several allowlists match it', () => {
    const s = sum([rec({ read: 'offsetWidth', write: 'Element.className =' })]);
    const r = checkNoReflow(s, {
        allowReads: ['offsetWidth'],
        allowWrites: ['Element.className'],
        ignoreSites: ['app.js']
    });
    assert.equal(r.excluded, 1);
    assert.equal(r.counted, 0);
});

// --- maxPerTask ------------------------------------------------------------

test('maxPerTask counts within one synchronous block, not across the run', () => {
    // Six reflows, two per task: a total budget would fail, per-task passes.
    const records = [];
    for (let t = 0; t < 3; t++) {
        records.push(rec({ taskId: t }), rec({ taskId: t }));
    }
    const r = checkNoReflow(sum(records), { maxReflows: 6, maxPerTask: 2 });
    assert.equal(r.ok, true);

    const r2 = checkNoReflow(sum(records), { maxReflows: 6, maxPerTask: 1 });
    assert.equal(r2.ok, false);
    assert.equal(r2.violations[0].metric, 'maxPerTask');
    assert.equal(r2.violations[0].actual, 2);
});

test('maxPerTask names the worst task', () => {
    const records = [
        rec({ taskId: 0 }),
        rec({ taskId: 7 }), rec({ taskId: 7 }), rec({ taskId: 7 })
    ];
    const r = checkNoReflow(sum(records), { maxReflows: 99, maxPerTask: 2 });
    assert.match(r.violations[0].reason, /task #7 forced 3 reflows/);
});

test('maxPerTask counts after exclusions, not before', () => {
    const records = [
        rec({ taskId: 1, read: 'offsetWidth' }),
        rec({ taskId: 1, read: 'offsetWidth' }),
        rec({ taskId: 1, read: 'clientHeight' })
    ];
    const r = checkNoReflow(sum(records), {
        maxReflows: 99, maxPerTask: 1, allowReads: ['offsetWidth']
    });
    assert.equal(r.ok, true);
});

test('both rules can fail in one run', () => {
    const records = [rec({ taskId: 0 }), rec({ taskId: 0 })];
    const r = checkNoReflow(sum(records), { maxReflows: 0, maxPerTask: 1 });
    assert.equal(r.violations.length, 2);
    assert.deepEqual(r.violations.map((v) => v.metric).sort(),
        ['maxPerTask', 'maxReflows']);
});

// --- fail-closed evidence checks ------------------------------------------

test('truncated records fail any per-record rule rather than passing', () => {
    // Zero counted reflows through a torn record set is not a clean run.
    const s = sum([], { total: 500, stored: 0, truncated: true });
    const r = checkNoReflow(s, { maxReflows: 1000, allowReads: ['offsetWidth'] });
    assert.equal(r.ok, false);
    assert.equal(r.verified, false);
    assert.equal(r.violations[0].metric, 'records');
    assert.match(r.violations[0].reason, /truncated by the storage cap/);
});

test('truncation does not block rules that need no records', () => {
    const s = sum([], { total: 3, stored: 0, truncated: true });
    const r = checkNoReflow(s, { maxReflows: 5 });
    assert.equal(r.ok, true);
    assert.equal(r.verified, true);
});

test('maxReflows still gates exactly on a truncated run', () => {
    const s = sum([], { total: 500, stored: 0, truncated: true });
    const r = checkNoReflow(s, { maxReflows: 100 });
    assert.equal(r.ok, false);
    assert.equal(r.violations[0].actual, 500);
});

test('ignoreSites without captured stacks is unverifiable', () => {
    const s = sum([rec()], { stacks: false });
    const r = checkNoReflow(s, { ignoreSites: ['node_modules'] });
    assert.equal(r.verified, false);
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.metric === 'ignoreSites'));
});

test('a pre-1.1 summary without records fails per-record rules', () => {
    const legacy = { total: 0, stored: 0, byRead: {}, byWrite: {} };
    const r = checkNoReflow(legacy, { maxPerTask: 1 });
    assert.equal(r.verified, false);
    assert.match(r.violations[0].reason, /no `records` array/);
});

test('a pre-1.1 summary still works for the plain count budget', () => {
    const legacy = { total: 2, stored: 2, byRead: {}, byWrite: {} };
    assert.equal(checkNoReflow(legacy, { maxReflows: 5 }).ok, true);
    assert.equal(checkNoReflow(legacy).ok, false);
});

// --- assertNoReflow --------------------------------------------------------

test('assertNoReflow returns the report when the budget holds', () => {
    const r = assertNoReflow(sum([]));
    assert.equal(r.ok, true);
});

test('assertNoReflow throws ReflowBudgetError carrying the report', () => {
    let caught = null;
    try {
        assertNoReflow(sum([rec(), rec()]));
    } catch (e) {
        caught = e;
    }
    assert.ok(caught instanceof ReflowBudgetError);
    assert.ok(caught instanceof Error);
    assert.equal(caught.name, 'ReflowBudgetError');
    assert.equal(caught.report.counted, 2);
    assert.equal(caught.violations.length, 1);
    assert.match(caught.message, /Reflow budget exceeded \(1 rule breached\)/);
    assert.match(caught.message, /2 forced reflows counted, limit 0/);
});

test('error message pluralises rule count', () => {
    try {
        assertNoReflow(sum([rec({ taskId: 0 }), rec({ taskId: 0 })]),
            { maxReflows: 0, maxPerTask: 1 });
        assert.fail('should have thrown');
    } catch (e) {
        assert.match(e.message, /\(2 rules breached\)/);
    }
});

test('excluded count is surfaced in the failure reason', () => {
    const s = sum([
        rec({ read: 'offsetWidth' }),
        rec({ read: 'clientHeight' })
    ]);
    const r = checkNoReflow(s, { allowReads: ['offsetWidth'] });
    assert.match(r.violations[0].reason, /1 excluded by allowlist/);
});
