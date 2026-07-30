// Reporting layer (v1.6): verdict derivation + the four formatters. Pure
// functions over a checkNoReflow report -- no DOM needed, so these run in Node
// directly. CLI exit-code behaviour is in test/10-cli.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    _verdictOf, formatConsole, formatJson, formatMarkdown, formatGithubAnnotations, VERSION
} from '../LayoutProfiler.js';

function report(over) {
    return Object.assign({
        ok: true, verified: true, total: 0, counted: 0, excluded: 0,
        excludedBy: { reads: 0, writes: 0, sites: 0, expected: 0 },
        cost: null, violations: []
    }, over);
}
const PASS = report({});
const FAIL = report({ ok: false, total: 5, counted: 5, violations: [
    { metric: 'maxReflows', limit: 0, actual: 5, reason: 'maxReflows: 5 forced reflows counted, limit 0' }
] });
const INC = report({ ok: false, verified: false, violations: [
    { metric: 'patched', reason: 'coverage incomplete' }
] });

// ---------------------------------------------------------------------------
// _verdictOf -- the projection of ok/verified
// ---------------------------------------------------------------------------

test('_verdictOf maps the three (ok, verified) combinations', () => {
    assert.equal(_verdictOf(PASS), 'pass');
    assert.equal(_verdictOf(FAIL), 'fail');
    assert.equal(_verdictOf(INC), 'inconclusive');
});

test('_verdictOf: verified=false is inconclusive even when ok is true', () => {
    assert.equal(_verdictOf(report({ ok: true, verified: false })), 'inconclusive',
        'an unverifiable run is never a pass, even if no rule tripped');
});

test('_verdictOf: a non-object is inconclusive, not a crash', () => {
    assert.equal(_verdictOf(null), 'inconclusive');
    assert.equal(_verdictOf(undefined), 'inconclusive');
});

// ---------------------------------------------------------------------------
// formatConsole
// ---------------------------------------------------------------------------

test('formatConsole tags each verdict', () => {
    assert.match(formatConsole(PASS), /^\[PASS\]/);
    assert.match(formatConsole(FAIL), /^\[FAIL\]/);
    assert.match(formatConsole(INC), /^\[INCONCLUSIVE\]/);
});

test('formatConsole lists violation reasons on a fail', () => {
    const out = formatConsole(FAIL);
    assert.match(out, /maxReflows: 5 forced reflows counted/);
});

test('formatConsole survives a malformed violation entry', () => {
    const bad = report({ ok: false, violations: [null, 'oops', { metric: 'x', reason: 'y' }] });
    assert.doesNotThrow(() => formatConsole(bad));
    assert.match(formatConsole(bad), /malformed violation/);
});

// ---------------------------------------------------------------------------
// formatJson -- the layout.json envelope
// ---------------------------------------------------------------------------

test('formatJson emits a schema-versioned envelope with the verdict and raw report', () => {
    const env = JSON.parse(formatJson(FAIL));
    assert.equal(env.schema, 'lite-layout-report/1');
    assert.equal(env.version, VERSION);
    assert.equal(env.verdict, 'fail');
    assert.equal(env.report.counted, 5);
    assert.equal(typeof env.generatedAt, 'string');
});

test('formatJson round-trips: the enveloped report re-derives the same verdict', () => {
    const env = JSON.parse(formatJson(INC));
    assert.equal(_verdictOf(env.report), 'inconclusive');
});

// ---------------------------------------------------------------------------
// formatMarkdown
// ---------------------------------------------------------------------------

test('formatMarkdown renders a table and the verdict tag', () => {
    const md = formatMarkdown(FAIL);
    assert.match(md, /lite-layout-profiler: FAIL/);
    assert.match(md, /\| counted \| 5 \|/);
    assert.match(md, /maxReflows/);
});

test('formatMarkdown on a pass shows no violations section', () => {
    const md = formatMarkdown(PASS);
    assert.match(md, /PASS/);
    assert.doesNotMatch(md, /Violations:/);
});

// ---------------------------------------------------------------------------
// formatGithubAnnotations
// ---------------------------------------------------------------------------

test('formatGithubAnnotations emits ::error per violation on fail', () => {
    const gh = formatGithubAnnotations(FAIL);
    assert.match(gh, /^::error title=lite-layout-profiler::/);
    assert.equal(gh.split('\n').length, 1, 'one annotation for one violation');
});

test('formatGithubAnnotations emits a single ::warning on inconclusive', () => {
    const gh = formatGithubAnnotations(INC);
    assert.match(gh, /^::warning title=lite-layout-profiler::/);
});

test('formatGithubAnnotations emits nothing on pass', () => {
    assert.equal(formatGithubAnnotations(PASS), '');
});

test('formatGithubAnnotations escapes newlines and percent signs in reasons', () => {
    const tricky = report({ ok: false, violations: [
        { metric: 'x', reason: 'line one\nline two 100% done' }
    ] });
    const gh = formatGithubAnnotations(tricky);
    assert.doesNotMatch(gh, /\n.*line two/, 'a literal newline would split the annotation');
    assert.match(gh, /%0A/, 'newline is escaped');
    assert.match(gh, /%25/, 'percent is escaped');
});
