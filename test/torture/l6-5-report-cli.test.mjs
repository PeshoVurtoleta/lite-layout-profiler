// L6.5 -- Reporting layer and CLI, adversarial. Axes G, H, I.
//
// The formatters and the gate CLI sit between a report and a human or a CI
// exit code, so their failure mode is a lie: a malformed report that renders
// as a clean PASS, an envelope that loses the verdict on round-trip, a CLI that
// exits 0 on something it could not actually read. These axes attack exactly
// those.
//
//   Axis J -- a formatter never crashes and never upgrades a non-pass to a
//             pass, no matter how malformed the report.
//   Axis K -- the envelope is faithful: what goes in comes out, verdict intact,
//             across every verdict and a round-trip through JSON.
//   Axis L -- the CLI's exit code always matches the verdict it printed, and an
//             unreadable input is exit 3, never a silent 0.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    _verdictOf, formatConsole, formatJson, formatMarkdown, formatGithubAnnotations
} from '../../LayoutProfiler.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', '..', 'bin', 'LiteLayoutGate.mjs');
const TMP = mkdtempSync(join(tmpdir(), 'llp-l65-'));
const ALL = [formatConsole, formatJson, formatMarkdown, formatGithubAnnotations];

function run(args) {
    const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
function writeTmp(name, obj) {
    const p = join(TMP, name);
    writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
    return p;
}

// =============================================================================
// AXIS J -- formatters never crash, never fabricate a pass
// =============================================================================

test('[J] every formatter survives a report missing all fields', () => {
    for (const f of ALL) assert.doesNotThrow(() => f({}), f.name + ' on {}');
});

test('[J] every formatter survives null and undefined', () => {
    for (const f of ALL) {
        assert.doesNotThrow(() => f(null), f.name + ' on null');
        assert.doesNotThrow(() => f(undefined), f.name + ' on undefined');
    }
});

test('[J] violations that are not an array do not crash a formatter', () => {
    const weird = { ok: false, verified: true, violations: 'not an array', counted: 1, total: 1 };
    for (const f of ALL) assert.doesNotThrow(() => f(weird), f.name);
});

test('[J] a report with a broken verified flag never renders as PASS', () => {
    // verified must be exactly true to reach pass; anything else is inconclusive.
    for (const v of [undefined, null, 0, '', 'true', NaN]) {
        const r = { ok: true, verified: v, violations: [] };
        assert.notEqual(_verdictOf(r), 'pass',
            'verified=' + String(v) + ' must not be a pass');
        assert.doesNotMatch(formatConsole(r), /^\[PASS\]/);
    }
});

test('[J] a malformed violation entry renders without throwing in all formats', () => {
    const r = { ok: false, verified: true, counted: 3, total: 3,
        violations: [null, 42, 'oops', { metric: 'x' }, { reason: 'y' }] };
    for (const f of ALL) assert.doesNotThrow(() => f(r), f.name);
    assert.match(formatGithubAnnotations(r), /malformed violation entry/);
});

// =============================================================================
// AXIS K -- the envelope is faithful
// =============================================================================

test('[K] every verdict survives a formatJson round-trip', () => {
    const cases = [
        { ok: true,  verified: true,  violations: [] },                 // pass
        { ok: false, verified: true,  violations: [{ metric: 'm', reason: 'r' }] }, // fail
        { ok: false, verified: false, violations: [] }                  // inconclusive
    ];
    for (const c of cases) {
        const env = JSON.parse(formatJson(c));
        assert.equal(env.verdict, _verdictOf(c));
        assert.equal(_verdictOf(env.report), _verdictOf(c),
            'the re-derived verdict from the round-tripped report matches');
    }
});

test('[K] the envelope preserves the raw report byte-for-byte in structure', () => {
    const r = { ok: false, verified: true, total: 7, counted: 5, excluded: 2,
        excludedBy: { reads: 1, writes: 0, sites: 1, expected: 0 }, cost: null,
        violations: [{ metric: 'maxReflows', limit: 0, actual: 5, reason: 'over' }] };
    const env = JSON.parse(formatJson(r));
    assert.deepEqual(env.report, r, 'nothing in the report is dropped or mutated');
});

test('[K] the envelope carries the schema and a version', () => {
    const env = JSON.parse(formatJson({ ok: true, verified: true, violations: [] }));
    assert.equal(env.schema, 'lite-layout-report/1');
    assert.match(env.version, /^\d+\.\d+\.\d+$/);
});

// =============================================================================
// AXIS L -- the CLI exit code always matches the printed verdict
// =============================================================================

test('[L] the printed verdict and the exit code never disagree', () => {
    const cases = [
        ['p.json', { ok: true,  verified: true,  violations: [] }, 0, /\[PASS\]/],
        ['f.json', { ok: false, verified: true,  violations: [{ metric: 'm', reason: 'r' }] }, 1, /\[FAIL\]/],
        ['i.json', { ok: false, verified: false, violations: [] }, 2, /\[INCONCLUSIVE\]/]
    ];
    for (const [name, rep, code, re] of cases) {
        const p = writeTmp(name, formatJson(rep));
        const r = run([p]);
        assert.equal(r.code, code, name + ' exit');
        assert.match(r.out, re, name + ' printed verdict');
    }
});

test('[L] an unreadable input is exit 3, never a silent 0', () => {
    assert.equal(run([writeTmp('garbage.json', 'this is not json at all')]).code, 3);
    assert.equal(run([join(TMP, 'nope.json')]).code, 3);           // missing
    assert.equal(run([writeTmp('arr.json', '[1,2,3]')]).code, 3);  // array, not a report
    assert.equal(run([writeTmp('num.json', '42')]).code, 3);       // scalar
});

test('[L] a report whose booleans are absent is not accepted as a bare report', () => {
    // Missing ok/verified means it is not a checkNoReflow report; the CLI must
    // not treat it as a pass by default. It has no schema and no gate booleans.
    const p = writeTmp('noflags.json', { total: 3, violations: [] });
    assert.equal(run([p]).code, 3);
});

test('[L] --format github on a failing input still exits 1', () => {
    const p = writeTmp('ghfail.json', formatJson({ ok: false, verified: true,
        violations: [{ metric: 'm', reason: 'r' }] }));
    const r = run([p, '--format', 'github']);
    assert.equal(r.code, 1);
    assert.match(r.out, /::error/);
});
