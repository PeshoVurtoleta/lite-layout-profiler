// Mock report corpus: the sample lite-layout-report/1 envelopes under mocks/.
//
// These files exist so a human (or the ReflowForge viewer) has a realistic
// report to look at for every verdict the tool can reach -- pass, fail (on
// counts, cost, rAF, and thrash), inconclusive (foreign patch, realm hole) --
// plus the two look-alikes the viewer must reject. They are checked into the
// repo but excluded from the npm package, like demo/ and viewer/.
//
// This suite is what keeps them from rotting. Every mock is driven through the
// two consumers that must agree on it -- the CLI gate (exit code) and the viewer
// classifier (derived verdict / rejection code) -- and every report mock is
// checked to still match the exact envelope shape the live formatJson emits. A
// mock that drifts from the schema, or a gate/viewer that changes its verdict on
// one, fails here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkNoReflow, formatJson } from '../LayoutProfiler.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const MOCKS = join(ROOT, 'mocks');
const GATE = join(ROOT, 'bin', 'LiteLayoutGate.mjs');
const VIEWER = join(ROOT, 'viewer', 'index.html');

// file -> { cli exit code, derived verdict } for the seven report envelopes.
const REPORTS = [
    { file: 'pass.json', cli: 0, verdict: 'pass' },
    { file: 'fail-reflows.json', cli: 1, verdict: 'fail' },
    { file: 'fail-cost.json', cli: 1, verdict: 'fail' },
    { file: 'fail-raf.json', cli: 1, verdict: 'fail' },
    { file: 'thrash.json', cli: 1, verdict: 'fail' },
    { file: 'inconclusive-foreign.json', cli: 2, verdict: 'inconclusive' },
    { file: 'inconclusive-realm-hole.json', cli: 2, verdict: 'inconclusive' }
];

// file -> { cli exit code, viewer rejection code } for the two look-alikes.
const REJECTS = [
    { file: 'reject-summary.json', cli: 3, code: 'summary' },
    { file: 'reject-gc-report.json', cli: 3, code: 'wrong_tool' }
];

function read(file) {
    return readFileSync(join(MOCKS, file), 'utf8');
}
function gateExit(file) {
    return spawnSync(process.execPath, [GATE, join(MOCKS, file)], { encoding: 'utf8' }).status;
}

// Extract the viewer's pure classifier (same approach as 12-viewer.test.mjs).
async function loadViewerFns() {
    const html = readFileSync(VIEWER, 'utf8');
    const body = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
    function grab(name, kind) {
        const re = kind === 'class'
            ? new RegExp('class ' + name + '[\\s\\S]*?\\n\\}', '')
            : new RegExp('function ' + name + '\\s*\\([\\s\\S]*?\\n\\}', '');
        const found = body.match(re);
        assert.ok(found, 'could not extract ' + name + ' from the viewer');
        return found[0];
    }
    const src = grab('ReportError', 'class') + '\n' +
        grab('parseDocument') + '\n' + grab('deriveVerdict') + '\n' + grab('identify') + '\n' +
        'export { parseDocument, identify, deriveVerdict, ReportError };';
    return import('data:text/javascript,' + encodeURIComponent(src));
}

const viewerPresent = existsSync(VIEWER);

// ---------------------------------------------------------------------------
// existence
// ---------------------------------------------------------------------------

test('every expected mock file is present', () => {
    for (const { file } of [...REPORTS, ...REJECTS]) {
        assert.ok(existsSync(join(MOCKS, file)), 'missing mock: ' + file);
    }
});

// ---------------------------------------------------------------------------
// the CLI gate agrees with each mock's intended verdict
// ---------------------------------------------------------------------------

for (const { file, cli } of [...REPORTS, ...REJECTS]) {
    test('CLI gates ' + file + ' with exit ' + cli, () => {
        assert.equal(gateExit(file), cli);
    });
}

// ---------------------------------------------------------------------------
// the viewer classifier agrees with each mock (verdict, or rejection code)
// ---------------------------------------------------------------------------

test('the viewer classifier derives the right verdict for every report mock',
    { skip: !viewerPresent ? 'viewer/index.html not present' : false }, async () => {
        const fns = await loadViewerFns();
        for (const { file, verdict } of REPORTS) {
            const id = fns.identify(fns.parseDocument(read(file)));
            assert.equal(fns.deriveVerdict(id.report), verdict, file + ' should derive ' + verdict);
        }
    });

test('the viewer classifier rejects the look-alikes with their specific code',
    { skip: !viewerPresent ? 'viewer/index.html not present' : false }, async () => {
        const fns = await loadViewerFns();
        for (const { file, code } of REJECTS) {
            try {
                fns.identify(fns.parseDocument(read(file)));
                assert.fail(file + ' should have been rejected');
            } catch (e) {
                assert.equal(e.code, code, file + ' should reject with code ' + code);
            }
        }
    });

// ---------------------------------------------------------------------------
// conformance: the report mocks still match the live envelope shape
// ---------------------------------------------------------------------------

test('every report mock matches the envelope shape formatJson emits today', () => {
    // A fresh envelope straight from the library is the reference shape.
    const ref = JSON.parse(formatJson(checkNoReflow(
        { total: 0, patched: { complete: true } }, { maxReflows: 0 })));
    const envelopeKeys = Object.keys(ref).sort();
    const reportKeys = Object.keys(ref.report).sort();

    for (const { file } of REPORTS) {
        const doc = JSON.parse(read(file));
        assert.deepEqual(Object.keys(doc).sort(), envelopeKeys, file + ' envelope keys');
        assert.equal(doc.schema, 'lite-layout-report/1', file + ' schema');
        // The mocks are illustrative fixtures, not regenerated every release, so
        // pin the SHAPE, not the exact version -- only require a semver string so
        // a release need not touch the corpus to stay green.
        assert.match(doc.version, /^\d+\.\d+\.\d+/, file + ' version is a semver string');
        assert.deepEqual(Object.keys(doc.report).sort(), reportKeys, file + ' report keys');
        // The verdict stamped in the envelope must match the one derived from the
        // booleans -- the envelope never states a verdict its own report denies.
        assert.equal(doc.verdict, _verdict(doc.report), file + ' stamped verdict is honest');
    }
});

// Local mirror of the viewer/CLI verdict rule, so the conformance check does not
// depend on the viewer being present.
function _verdict(r) {
    if (!r || r.verified !== true) return 'inconclusive';
    return r.ok ? 'pass' : 'fail';
}
