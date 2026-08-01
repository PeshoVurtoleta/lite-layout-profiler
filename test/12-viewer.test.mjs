// ReflowForge viewer (v2.0) -- the browser viewer for lite-layout-report/1.
// The viewer is a single HTML file under viewer/ (shipped to GitHub, excluded
// from the npm package). It is browser-only, so it cannot be imported. Instead,
// following the approach proven on GCForge, this test EXTRACTS the pure
// classifier functions (parseDocument, identify, deriveVerdict) from the inline
// module and exercises them in Node against real formatJson envelopes and the
// look-alikes the viewer must reject. The DOM rendering is out of scope here --
// only a real browser renders it -- but the classification and verdict logic,
// where the correctness lives, is fully covered.
//
// If viewer/index.html is absent (a checkout without it), the suite skips rather
// than fails: the viewer is a GitHub artifact, not a package file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLayoutProfiler, checkNoReflow, formatJson } from '../LayoutProfiler.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWER = join(HERE, '..', 'viewer', 'index.html');

// A minimal DOM so createLayoutProfiler can bind. node:test has no DOM; this
// suite runs alongside the others which already install one, but we install our
// own defensively in case of isolation.
function installDom() {
    // happy-dom is a devDependency used by the live-DOM suites.
    return import('happy-dom').then(({ Window }) => {
        const w = new Window();
        for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement',
            'CSSStyleDeclaration', 'DOMTokenList']) {
            globalThis[k] = k === 'window' ? w : (k === 'document' ? w.document : w[k]);
        }
        return w;
    });
}

// Extract the three pure functions from the inline module and import them.
async function loadViewerFns() {
    const html = readFileSync(VIEWER, 'utf8');
    const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
    const body = m[1];
    function grab(name, kind) {
        const re = kind === 'class'
            ? new RegExp('class ' + name + '[\\s\\S]*?\\n\\}', '')
            : new RegExp('function ' + name + '\\s*\\([\\s\\S]*?\\n\\}', '');
        const found = body.match(re);
        assert.ok(found, 'could not extract ' + name + ' from the viewer');
        return found[0];
    }
    const src = grab('ReportError', 'class') + '\n' +
        grab('parseDocument') + '\n' +
        grab('deriveVerdict') + '\n' +
        grab('identify') + '\n' +
        'export { parseDocument, identify, deriveVerdict, ReportError };';
    return import('data:text/javascript,' + encodeURIComponent(src));
}

const present = existsSync(VIEWER);

test('viewer classifier: real reports are accepted, look-alikes rejected', { skip: !present ? 'viewer/index.html not present' : false }, async () => {
    const w = await installDom();
    const fns = await loadViewerFns();

    // Real reports from the live library.
    const pass = createLayoutProfiler({ warnToConsole: false });
    const passJson = formatJson(checkNoReflow(pass.summary(), { maxReflows: 0 }));
    pass.destroy();

    const fail = createLayoutProfiler({ warnToConsole: false });
    const fe = w.document.createElement('div'); w.document.body.appendChild(fe);
    for (let i = 0; i < 3; i++) { fe.style.width = (10 + i) + 'px'; void fe.offsetWidth; }
    const failJson = formatJson(checkNoReflow(fail.summary(), { maxReflows: 0 }));
    fail.destroy();

    const sum = createLayoutProfiler({ warnToConsole: false });
    const summaryJson = JSON.stringify(sum.summary());
    sum.destroy();

    function accepts(text) {
        const doc = fns.parseDocument(text);
        return fns.identify(doc);
    }
    function rejectsWith(text, code) {
        try { accepts(text); assert.fail('should have rejected'); }
        catch (e) { assert.equal(e.code, code); }
    }

    // Accepts real reports, with the correct derived verdict.
    const passId = accepts(passJson);
    assert.equal(fns.deriveVerdict(passId.report), 'pass');
    const failId = accepts(failJson);
    assert.equal(fns.deriveVerdict(failId.report), 'fail');

    // Rejects the look-alikes, each with its specific code.
    rejectsWith(summaryJson, 'summary');
    rejectsWith(JSON.stringify({ schema: 'lite-gc-report/1', report: { verdict: 'pass', kind: 'gc' } }), 'wrong_tool');
    rejectsWith('not json at all', 'not_json');
    rejectsWith('{"a":1}', 'unrecognised');
    rejectsWith('[1,2,3]', 'not_object');
});

test('viewer verdict derivation is fail-closed on verified', { skip: !present ? 'viewer/index.html not present' : false }, async () => {
    const fns = await loadViewerFns();
    // verified must be exactly true for a definitive verdict.
    assert.equal(fns.deriveVerdict({ ok: true, verified: true }), 'pass');
    assert.equal(fns.deriveVerdict({ ok: false, verified: true }), 'fail');
    assert.equal(fns.deriveVerdict({ ok: true, verified: false }), 'inconclusive');
    assert.equal(fns.deriveVerdict({ ok: true }), 'inconclusive');   // verified absent
    assert.equal(fns.deriveVerdict(null), 'inconclusive');
});

test('viewer accepts a bare checkNoReflow report (no envelope)', { skip: !present ? 'viewer/index.html not present' : false }, async () => {
    const fns = await loadViewerFns();
    const bare = JSON.stringify({
        ok: false, verified: true, total: 2, counted: 2, excluded: 0,
        excludedBy: { reads: 0, writes: 0, sites: 0, expected: 0 },
        cost: null, violations: [{ metric: 'maxReflows', reason: 'over' }]
    });
    const id = fns.identify(fns.parseDocument(bare));
    assert.equal(id.envelope, null);
    assert.equal(fns.deriveVerdict(id.report), 'fail');
});

test('viewer detects an envelope/booleans verdict mismatch (booleans win)', { skip: !present ? 'viewer/index.html not present' : false }, async () => {
    const fns = await loadViewerFns();
    // Envelope claims pass; booleans say fail.
    const doc = fns.parseDocument(JSON.stringify({
        schema: 'lite-layout-report/1', version: '1.7.0', verdict: 'pass',
        report: { ok: false, verified: true, total: 1, counted: 1, excluded: 0,
            excludedBy: {}, cost: null, violations: [{ metric: 'maxReflows', reason: 'over' }] }
    }));
    const id = fns.identify(doc);
    assert.equal(id.envelope.verdict, 'pass', 'the stated verdict is preserved for the mismatch note');
    assert.equal(fns.deriveVerdict(id.report), 'fail', 'the derived verdict is the truth');
});
