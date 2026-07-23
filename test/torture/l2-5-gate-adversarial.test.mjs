// L2.5 -- Gate adversarial. Axes A, B, C, D.
//
// The gate is handed a plain object by a caller it does not control: a JSON
// payload from a browser, a file on disk, a summary from an older build. Every
// scenario here is a summary that lies, is incomplete, or is malformed, and
// the claim under test is always the same one: the gate must never report a
// pass it could not justify.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    checkNoReflow, assertNoReflow, ReflowBudgetError, READ_NAMES
} from '../../LayoutProfiler.js';
import {
    assertAxisA, assertAxisB, assertAxisC, assertAxisD,
    makeRecord, makeSummary
} from './harness.mjs';

// ---------------------------------------------------------------------------
// Axis A -- MUST be unverified
// ---------------------------------------------------------------------------

test('A: truncated records against every per-record rule', () => {
    const s = makeSummary([], { total: 5000, stored: 0, truncated: true });
    assertAxisA(s, { maxReflows: 9999, maxPerTask: 9999 }, 'truncated + maxPerTask');
    assertAxisA(s, { maxReflows: 9999, allowReads: ['offsetWidth'] }, 'truncated + allowReads');
    assertAxisA(s, { maxReflows: 9999, allowWrites: ['CSS'] }, 'truncated + allowWrites');
    assertAxisA(s, { maxReflows: 9999, ignoreSites: ['x'] }, 'truncated + ignoreSites');
    assertAxisA(s, { maxReflows: 9999, maxCostMs: 9999 }, 'truncated + maxCostMs');
    assertAxisA(s, { maxReflows: 9999, maxTotalCostMs: 9999 }, 'truncated + maxTotalCostMs');
});

test('A: records absent entirely, per-record rules asked anyway', () => {
    const legacy = { total: 3, stored: 3, byRead: {}, byWrite: {} };
    assertAxisA(legacy, { maxReflows: 99, maxPerTask: 99 }, 'no records + maxPerTask');
    assertAxisA(legacy, { maxReflows: 99, maxCostMs: 99 }, 'no records + maxCostMs');
});

test('A: records present but not an array', () => {
    for (const bad of ['[]', 42, {}, true, { length: 3 }]) {
        const s = makeSummary([], { records: bad, total: 4 });
        assertAxisA(s, { maxReflows: 99, maxPerTask: 99 },
            'records=' + JSON.stringify(bad));
    }
});

test('A: ignoreSites asked for on a run recorded without stacks', () => {
    const s = makeSummary([makeRecord()], { stacks: false });
    assertAxisA(s, { maxReflows: 99, ignoreSites: ['node_modules'] }, 'no stacks');
});

test('A: any unmeasured cost poisons a cost budget, however generous', () => {
    const s = makeSummary([
        makeRecord({ costMs: 0.5 }),
        makeRecord({ costMs: null, belowGranularity: true })
    ]);
    assertAxisA(s, { maxReflows: 99, maxTotalCostMs: 1e9 }, 'one null among measured');
    assertAxisA(s, { maxReflows: 99, maxCostMs: 1e9 }, 'one null, huge maxCostMs');
});

test('A: a thousand sub-resolution stalls cannot slide under a budget', () => {
    // The exact failure the null-is-not-zero rule exists to prevent: summing
    // nulls as zeroes would make this run look free.
    const many = [];
    for (let i = 0; i < 1000; i++) {
        many.push(makeRecord({ costMs: null, belowGranularity: true }));
    }
    assertAxisA(makeSummary(many), { maxReflows: 5000, maxTotalCostMs: 1 },
        '1000 sub-resolution stalls');
});

test('A: NaN cost is not a measurement', () => {
    // NaN compares false against every limit, so treating it as measured
    // would let it pass any budget silently.
    const s = makeSummary([makeRecord({ costMs: NaN })]);
    assertAxisA(s, { maxReflows: 99, maxCostMs: 4 }, 'NaN costMs');
    assertAxisA(s, { maxReflows: 99, maxTotalCostMs: 4 }, 'NaN costMs, total');
});

test('A: infinite and negative costs are not measurements', () => {
    assertAxisA(makeSummary([makeRecord({ costMs: Infinity })]),
        { maxReflows: 99, maxCostMs: 4 }, 'Infinity costMs');
    assertAxisA(makeSummary([makeRecord({ costMs: -Infinity })]),
        { maxReflows: 99, maxCostMs: 4 }, '-Infinity costMs');
    assertAxisA(makeSummary([makeRecord({ costMs: -5 })]),
        { maxReflows: 99, maxCostMs: 4 }, 'negative costMs');
});

test('A: malformed records are refused, not stepped over', () => {
    for (const bad of [null, undefined, 42, 'record', []]) {
        const s = makeSummary([], { records: [makeRecord(), bad], total: 2 });
        assertAxisA(s, { maxReflows: 99, maxPerTask: 99 },
            'record entry ' + String(bad));
    }
});

test('A: records missing the fields a rule reads', () => {
    const noRead = { id: 1, taskId: 0, write: 'w', readSite: 'a', writeSite: 'b' };
    assertAxisA(makeSummary([], { records: [noRead], total: 1 }),
        { maxReflows: 99, allowReads: ['offsetWidth'] }, 'record without read');

    const noSite = { id: 1, taskId: 0, read: 'offsetWidth', write: 'w' };
    assertAxisA(makeSummary([], { records: [noSite], total: 1 }),
        { maxReflows: 99, ignoreSites: ['x'] }, 'record without sites');

    const noTask = { id: 1, read: 'offsetWidth', write: 'w', readSite: 'a', writeSite: 'b' };
    assertAxisA(makeSummary([], { records: [noTask], total: 1 }),
        { maxReflows: 99, maxPerTask: 1 }, 'record without taskId');
});

test('A: a non-numeric total is not a count', () => {
    for (const bad of ['5', null, undefined, NaN, -1, Infinity, {}]) {
        const s = makeSummary([makeRecord()], { total: bad });
        assertAxisA(s, { maxReflows: 99 }, 'total=' + String(bad));
    }
});

test('A: a total smaller than the records it claims to summarise', () => {
    const s = makeSummary([makeRecord(), makeRecord(), makeRecord()], { total: 1 });
    assertAxisA(s, { maxReflows: 99, maxPerTask: 99 }, 'total < records.length');
});

test('A: truncated flag set while records look complete', () => {
    // A report edited by hand, or a merge of two runs. Believe the flag.
    const s = makeSummary([makeRecord()], { truncated: true, total: 1, stored: 1 });
    assertAxisA(s, { maxReflows: 99, maxPerTask: 99 }, 'truncated with records');
});

// ---------------------------------------------------------------------------
// Axis B -- real signal that MUST be found
// ---------------------------------------------------------------------------

test('B: one thrashing task among a hundred clean ones', () => {
    const recs = [];
    for (let t = 0; t < 100; t++) recs.push(makeRecord({ taskId: t }));
    for (let i = 0; i < 40; i++) recs.push(makeRecord({ taskId: 7 }));
    const rep = assertAxisB(makeSummary(recs), { maxReflows: 1000, maxPerTask: 5 },
        'burst hidden in a drip');
    assert.match(rep.violations[0].reason, /task #7/);
});

test('B: one expensive stall among a thousand cheap ones', () => {
    const recs = [];
    for (let i = 0; i < 1000; i++) recs.push(makeRecord({ costMs: 0.01 }));
    recs.push(makeRecord({ costMs: 40, readSite: '  at slowPath (a.js:1:1)' }));
    const rep = assertAxisB(makeSummary(recs), { maxReflows: 2000, maxCostMs: 4 },
        'one whale in a school of minnows');
    assert.match(rep.violations[0].reason, /40\.000 ms/);
    assert.match(rep.violations[0].reason, /slowPath/);
});

test('B: total cost breached only in aggregate, no single stall over limit', () => {
    const recs = [];
    for (let i = 0; i < 100; i++) recs.push(makeRecord({ costMs: 0.5 }));
    const rep = assertAxisB(makeSummary(recs),
        { maxReflows: 500, maxCostMs: 4, maxTotalCostMs: 16 }, 'death by a thousand cuts');
    assert.deepEqual(rep.violations.map((v) => v.metric), ['maxTotalCostMs']);
});

test('B: an allowlist that excludes almost everything still finds the remainder', () => {
    const recs = [];
    for (let i = 0; i < 500; i++) recs.push(makeRecord({ read: 'offsetWidth' }));
    recs.push(makeRecord({ read: 'clientHeight' }));
    const rep = assertAxisB(makeSummary(recs),
        { maxReflows: 0, allowReads: ['offsetWidth'] }, 'needle after exclusion');
    assert.equal(rep.counted, 1);
    assert.equal(rep.excluded, 500);
});

test('B: exclusions cannot drive the count below zero to fake a pass', () => {
    const rep = checkNoReflow(
        makeSummary([makeRecord(), makeRecord()]),
        { maxReflows: 0, allowReads: ['offsetWidth'] });
    assert.ok(rep.counted >= 0, 'counted must never go negative');
});

test('B: a breach in every rule at once reports every rule', () => {
    const recs = [
        makeRecord({ taskId: 0, costMs: 50 }),
        makeRecord({ taskId: 0, costMs: 50 })
    ];
    const rep = assertAxisB(makeSummary(recs),
        { maxReflows: 0, maxPerTask: 1, maxCostMs: 4, maxTotalCostMs: 10 },
        'all four rules');
    assert.deepEqual(rep.violations.map((v) => v.metric).sort(),
        ['maxCostMs', 'maxPerTask', 'maxReflows', 'maxTotalCostMs']);
});

// ---------------------------------------------------------------------------
// Axis C -- clean signal under hostile conditions, MUST pass
// ---------------------------------------------------------------------------

test('C: an empty run passes every rule it is given', () => {
    assertAxisC(makeSummary([]),
        { maxReflows: 0, maxPerTask: 1, maxCostMs: 0.001, maxTotalCostMs: 0.001 },
        'nothing happened');
});

test('C: unmeasured costs do not disturb rules that never asked about cost', () => {
    const recs = [];
    for (let i = 0; i < 200; i++) recs.push(makeRecord({ costMs: null, taskId: i }));
    assertAxisC(makeSummary(recs), { maxReflows: 200, maxPerTask: 1 }, 'counts only');
});

test('C: truncation does not disturb the one rule that survives it', () => {
    const s = makeSummary([], { total: 3, stored: 0, truncated: true });
    assertAxisC(s, { maxReflows: 5 }, 'maxReflows on a torn set');
});

test('C: huge but legal values do not overflow into a false breach', () => {
    const s = makeSummary([makeRecord({ costMs: 1e6, taskId: 2 ** 31 })]);
    assertAxisC(s, {
        maxReflows: Number.MAX_SAFE_INTEGER,
        maxPerTask: Number.MAX_SAFE_INTEGER,
        maxCostMs: 1e9,
        maxTotalCostMs: 1e9
    }, 'astronomical limits');
});

test('C: exactly at the limit is not over it', () => {
    const recs = [makeRecord({ taskId: 0, costMs: 2 }), makeRecord({ taskId: 0, costMs: 2 })];
    assertAxisC(makeSummary(recs),
        { maxReflows: 2, maxPerTask: 2, maxCostMs: 2, maxTotalCostMs: 4 },
        'boundary equality');
});

test('C: zero-cost records are measurements, not absences', () => {
    // A hand-built report may legitimately carry 0. It is a number, so it is
    // measured, and it passes any non-negative budget.
    assertAxisC(makeSummary([makeRecord({ costMs: 0 })]),
        { maxReflows: 9, maxCostMs: 0, maxTotalCostMs: 0 }, 'costMs exactly 0');
});

// ---------------------------------------------------------------------------
// Axis D -- self-consistency
// ---------------------------------------------------------------------------

test('D: checkNoReflow never mutates the summary it was handed', () => {
    const recs = [makeRecord({ costMs: 3 }), makeRecord({ costMs: 1 })];
    const s = makeSummary(recs);
    const wire = JSON.stringify(s);
    checkNoReflow(s, { maxReflows: 0, maxPerTask: 1, maxCostMs: 0.5, ignoreSites: ['app'] });
    assertAxisD(() => JSON.stringify(s) === wire, 'summary unchanged after check');
});

test('D: a deeply frozen summary can still be gated', () => {
    const s = makeSummary([makeRecord({ costMs: 9 })]);
    Object.freeze(s.records);
    for (const r of s.records) Object.freeze(r);
    Object.freeze(s.cost);
    Object.freeze(s);
    assertAxisD(() => checkNoReflow(s, { maxReflows: 9, maxCostMs: 1 }).ok === false,
        'frozen summary gated without mutation');
});

test('D: repeated checks of one summary agree exactly', () => {
    const s = makeSummary([makeRecord({ costMs: 5 }), makeRecord({ costMs: 1 })]);
    const rules = { maxReflows: 1, maxPerTask: 1, maxCostMs: 2 };
    const a = JSON.stringify(checkNoReflow(s, rules));
    const b = JSON.stringify(checkNoReflow(s, rules));
    assertAxisD(() => a === b, 'idempotent evaluation');
});

test('D: assertNoReflow and checkNoReflow agree on every verdict', () => {
    const cases = [
        [makeSummary([]), {}],
        [makeSummary([makeRecord()]), {}],
        [makeSummary([makeRecord({ costMs: null })]), { maxReflows: 9, maxCostMs: 1 }],
        [makeSummary([], { truncated: true, total: 9 }), { maxReflows: 99, maxPerTask: 1 }]
    ];
    for (const [s, rules] of cases) {
        const rep = checkNoReflow(s, rules);
        let threw = false;
        try { assertNoReflow(s, rules); } catch (e) {
            threw = true;
            assertAxisD(() => e instanceof ReflowBudgetError, 'error type');
            assertAxisD(() => JSON.stringify(e.report) === JSON.stringify(rep),
                'thrown report equals returned report');
        }
        assertAxisD(() => threw === !rep.ok, 'throw iff not ok');
    }
});

test('D: excludedBy always sums to excluded', () => {
    const recs = [
        makeRecord({ read: 'offsetWidth' }),
        makeRecord({ write: 'Element.className =' }),
        makeRecord({ readSite: '  at v (node_modules/x/y.js:1:1)' }),
        makeRecord({ read: 'clientHeight', write: 'Node.appendChild()' })
    ];
    const rep = checkNoReflow(makeSummary(recs), {
        maxReflows: 99,
        allowReads: ['offsetWidth'],
        allowWrites: ['Element.className'],
        ignoreSites: ['node_modules']
    });
    const sum = rep.excludedBy.reads + rep.excludedBy.writes + rep.excludedBy.sites;
    assertAxisD(() => sum === rep.excluded, 'excludedBy sums to excluded');
    assertAxisD(() => rep.counted === rep.total - rep.excluded, 'counted arithmetic');
});

test('D: a record matching several allowlists is excluded exactly once', () => {
    const r = makeRecord({ read: 'offsetWidth', write: 'Element.className =' });
    const rep = checkNoReflow(makeSummary([r]), {
        maxReflows: 99,
        allowReads: ['offsetWidth'],
        allowWrites: ['Element.className'],
        ignoreSites: ['app.js']
    });
    assertAxisD(() => rep.excluded === 1, 'no double exclusion');
});

// ---------------------------------------------------------------------------
// Rule-set hostility (config, not data)
// ---------------------------------------------------------------------------

test('prototype-ish keys are rejected as unknown rules, not honoured', () => {
    const s = makeSummary([]);
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
        const rules = {};
        Object.defineProperty(rules, key, { value: 1, enumerable: true, configurable: true });
        assert.throws(() => checkNoReflow(s, rules), TypeError, 'key ' + key);
    }
});

test('a null-prototype rules object behaves like any other', () => {
    const s = makeSummary([makeRecord()]);
    const rules = Object.create(null);
    rules.maxReflows = 5;
    assert.equal(checkNoReflow(s, rules).ok, true);

    const bad = Object.create(null);
    bad.nonsense = 1;
    assert.throws(() => checkNoReflow(s, bad), TypeError);
});

test('inherited rule properties are ignored, not silently applied', () => {
    const base = { maxReflows: 9999 };
    const rules = Object.create(base);
    // maxReflows is inherited, so the default of 0 must apply.
    assert.equal(checkNoReflow(makeSummary([makeRecord()]), rules).ok, false);
});

test('symbol-keyed rules do not smuggle past validation', () => {
    const rules = { maxReflows: 5 };
    rules[Symbol('maxCostMs')] = 0;
    assert.doesNotThrow(() => checkNoReflow(makeSummary([]), rules));
});

test('an empty-string rule key is rejected', () => {
    assert.throws(() => checkNoReflow(makeSummary([]), { '': 1 }), TypeError);
});

test('every known rule name round-trips through its own validator', () => {
    const s = makeSummary([]);
    assert.doesNotThrow(() => checkNoReflow(s, {
        maxReflows: 0, maxPerTask: 1, maxCostMs: 1, maxTotalCostMs: 1,
        allowReads: [], allowWrites: [], ignoreSites: []
    }));
});

test('numeric rules reject every non-number shape', () => {
    for (const key of ['maxReflows', 'maxPerTask', 'maxCostMs', 'maxTotalCostMs']) {
        for (const bad of ['1', null, {}, [], true, NaN, Infinity, -1, () => 1]) {
            const rules = {};
            rules[key] = bad;
            assert.throws(() => checkNoReflow(makeSummary([]), rules), TypeError,
                key + ' = ' + String(bad));
        }
    }
});

test('list rules reject every non-list-of-strings shape', () => {
    for (const key of ['allowWrites', 'ignoreSites']) {
        for (const bad of ['x', null, {}, 42, [1], [null], [undefined], [{}]]) {
            const rules = { maxReflows: 9 };
            rules[key] = bad;
            assert.throws(() => checkNoReflow(makeSummary([]), rules), TypeError,
                key + ' = ' + JSON.stringify(bad));
        }
    }
});

test('did-you-mean survives absurd key names without hanging', () => {
    const long = 'maxReflows'.repeat(400);
    const started = Date.now();
    assert.throws(() => checkNoReflow(makeSummary([]), { [long]: 1 }), TypeError);
    assert.ok(Date.now() - started < 1000, 'suggestion search must stay bounded');
});

test('allowReads validation covers the whole vocabulary and nothing else', () => {
    const s = makeSummary([]);
    assert.doesNotThrow(() => checkNoReflow(s, { allowReads: READ_NAMES.slice() }));
    assert.doesNotThrow(() => checkNoReflow(s, {
        allowReads: READ_NAMES.map((n) => (n.slice(-2) === '()' ? n.slice(0, -2) : n + '()'))
    }), 'parens are optional in both directions');
    for (const bad of ['', 'offsetwidth ', 'style.width', 'OFFSETWIDTH_']) {
        assert.throws(() => checkNoReflow(s, { allowReads: [bad] }), TypeError,
            'allowReads entry ' + JSON.stringify(bad));
    }
});

test('duplicate allowlist entries do not double-exclude', () => {
    const rep = checkNoReflow(makeSummary([makeRecord({ read: 'offsetWidth' })]), {
        maxReflows: 99,
        allowReads: ['offsetWidth', 'offsetWidth', 'offsetWidth()']
    });
    assert.equal(rep.excluded, 1);
});

test('summary itself must be an object', () => {
    for (const bad of [null, undefined, 'summary', 42, true]) {
        assert.throws(() => checkNoReflow(bad), TypeError, String(bad));
    }
});
