// CLI (v1.6): lite-layout-gate. Spawns the real bin against report fixtures and
// asserts the exit-code contract (0 pass / 1 fail / 2 inconclusive / 3 error)
// and the format/redirect behaviour. Uses the checked-in fixtures under
// test/fixtures for the pass/fail cases and writes temp files for the rest.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'LiteLayoutGate.mjs');
const FIX = join(HERE, 'fixtures');
const TMP = mkdtempSync(join(tmpdir(), 'llp-cli-'));

function run(args) {
    const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
function writeTmp(name, obj) {
    const p = join(TMP, name);
    writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
    return p;
}
function report(over) {
    return Object.assign({
        ok: true, verified: true, total: 0, counted: 0, excluded: 0,
        excludedBy: { reads: 0, writes: 0, sites: 0, expected: 0 },
        cost: null, violations: []
    }, over);
}

// ---------------------------------------------------------------------------
// exit-code contract
// ---------------------------------------------------------------------------

test('clean fixture (envelope) exits 0', () => {
    const r = run([join(FIX, 'clean.layout.json')]);
    assert.equal(r.code, 0);
    assert.match(r.out, /\[PASS\]/);
});

test('failing fixture (envelope) exits 1', () => {
    const r = run([join(FIX, 'failing.layout.json')]);
    assert.equal(r.code, 1);
    assert.match(r.out, /\[FAIL\]/);
});

test('an inconclusive report exits 2', () => {
    const p = writeTmp('inc.json', report({ ok: false, verified: false,
        violations: [{ metric: 'patched', reason: 'coverage incomplete' }] }));
    const r = run([p]);
    assert.equal(r.code, 2);
    assert.match(r.out, /\[INCONCLUSIVE\]/);
});

test('--allow-inconclusive does not change the exit-2 contract', () => {
    const p = writeTmp('inc2.json', report({ ok: false, verified: false, violations: [] }));
    assert.equal(run([p]).code, 2);
    assert.equal(run([p, '--allow-inconclusive']).code, 2);
});

test('a bare report (no envelope) is accepted', () => {
    const p = writeTmp('bare.json', report({ ok: false, total: 3, counted: 3,
        violations: [{ metric: 'maxReflows', reason: 'over' }] }));
    assert.equal(run([p]).code, 1);
});

// ---------------------------------------------------------------------------
// infrastructure errors -> exit 3
// ---------------------------------------------------------------------------

test('a missing file exits 3', () => {
    const r = run([join(TMP, 'does-not-exist.json')]);
    assert.equal(r.code, 3);
    assert.match(r.err, /cannot read/);
});

test('invalid JSON exits 3', () => {
    const p = writeTmp('bad.json', '{not valid');
    const r = run([p]);
    assert.equal(r.code, 3);
    assert.match(r.err, /invalid JSON/);
});

test('a summary (not a report) exits 3 with a redirect message', () => {
    const p = writeTmp('summary.json', { total: 3, patched: { complete: true }, byRead: {}, records: [] });
    const r = run([p]);
    assert.equal(r.code, 3);
    assert.match(r.err, /summary, not a gate report/);
    assert.match(r.err, /checkNoReflow/);
});

test('no arguments exits 3 with usage', () => {
    const r = run([]);
    assert.equal(r.code, 3);
    assert.match(r.err, /Usage:/);
});

test('an unknown option exits 3', () => {
    const r = run([join(FIX, 'clean.layout.json'), '--nonsense']);
    assert.equal(r.code, 3);
    assert.match(r.err, /unknown option/);
});

test('an unknown --format exits 3', () => {
    const r = run([join(FIX, 'clean.layout.json'), '--format', 'yaml']);
    assert.equal(r.code, 3);
    assert.match(r.err, /unknown --format/);
});

// ---------------------------------------------------------------------------
// formats
// ---------------------------------------------------------------------------

test('--format json emits the envelope', () => {
    const r = run([join(FIX, 'failing.layout.json'), '--format', 'json']);
    assert.equal(r.code, 1);
    const env = JSON.parse(r.out);
    assert.equal(env.schema, 'lite-layout-report/1');
    assert.equal(env.verdict, 'fail');
});

test('--format github emits an annotation on fail', () => {
    const r = run([join(FIX, 'failing.layout.json'), '--format', 'github']);
    assert.match(r.out, /::error title=lite-layout-profiler::/);
});

test('--out writes the envelope and still sets the exit code', () => {
    const outPath = join(TMP, 'written.json');
    const r = run([join(FIX, 'clean.layout.json'), '--out', outPath]);
    assert.equal(r.code, 0);
    const env = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(env.schema, 'lite-layout-report/1');
    assert.equal(env.verdict, 'pass');
});
