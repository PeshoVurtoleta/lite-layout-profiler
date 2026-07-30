#!/usr/bin/env node
// @zakkster/lite-layout-profiler CLI: lite-layout-gate
//
// Layout cannot be forced headless in Node -- this profiler patches real DOM
// getters and catches reflows a real layout engine triggers. So this CLI does
// NOT run the profiler. It gates a report the BROWSER produced: run the
// profiler in the page, call checkNoReflow, serialise with formatJson to a
// layout.json, and feed that file here (in CI, at prepublish, in a git hook).
//
// Usage:
//   lite-layout-gate <layout.json> [options]
//
// Options:
//   --format fmt          console | json | markdown | github  (default console)
//   --out path            Also write the JSON envelope to this path
//   --allow-inconclusive  Accepted for parity with lite-gc-gate (inconclusive is exit 2)
//   -h, --help            Show this help
//
// Input: a serialised checkNoReflow report, either
//   - a lite-layout-report/1 envelope (from formatJson), or
//   - a bare checkNoReflow report object.
// A summary (from profiler.summary()) is NOT a report -- it has no verdict
// until rules are applied, and applying rules is the browser's job. Feeding a
// summary exits 3 with a redirect message.
//
// Exit codes (identical to lite-gc-gate):
//   0  pass
//   1  fail
//   2  inconclusive
//   3  infrastructure error (file missing, bad JSON, not a report, bad option)

import { readFileSync, writeFileSync } from 'node:fs';
import {
    _verdictOf,
    formatConsole, formatJson, formatMarkdown, formatGithubAnnotations
} from '../LayoutProfiler.js';

const FORMATTERS = {
    console: formatConsole,
    json: formatJson,
    markdown: formatMarkdown,
    github: formatGithubAnnotations
};

function usage(err) {
    if (err) process.stderr.write('lite-layout-gate: ' + err + '\n\n');
    process.stderr.write([
        'Usage: lite-layout-gate <layout.json> [options]',
        '',
        'Gates a report a browser produced (serialise checkNoReflow with formatJson).',
        '',
        'Options:',
        '  --format fmt          console | json | markdown | github  (default console)',
        '  --out path            Also write the JSON envelope to this path',
        '  --allow-inconclusive  Accepted for parity (inconclusive is always exit 2)',
        '  -h, --help            Show this help',
        '',
        'Exit codes: 0=pass, 1=fail, 2=inconclusive, 3=infrastructure error'
    ].join('\n') + '\n');
    process.exit(3);
}

function parseArgs(argv) {
    const args = { file: null, format: 'console', out: null, allowInconclusive: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') usage();
        else if (a === '--format') { args.format = argv[++i]; }
        else if (a === '--out') { args.out = argv[++i]; }
        else if (a === '--allow-inconclusive') { args.allowInconclusive = true; }
        else if (a.startsWith('--')) usage('unknown option: ' + a);
        else if (args.file === null) { args.file = a; }
        else usage('unexpected argument: ' + a);
    }
    if (args.file === null) usage('missing <layout.json> path');
    if (!Object.prototype.hasOwnProperty.call(FORMATTERS, args.format)) {
        usage('unknown --format: ' + args.format + ' (console | json | markdown | github)');
    }
    return args;
}

// Pull the bare checkNoReflow report out of whatever was serialised. Accept an
// envelope ({ schema, report }) or a bare report ({ ok, verified, violations }).
// Reject a summary (has `patched`/`byRead` but no gate fields) with guidance.
function extractReport(doc, file) {
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
        fail3('not a report object: ' + file + ' does not contain a JSON object');
    }
    // Envelope form.
    if (typeof doc.schema === 'string' && doc.schema.indexOf('lite-layout-report/') === 0) {
        if (doc.report && typeof doc.report === 'object') return doc.report;
        fail3('malformed envelope: ' + file + ' has schema ' + doc.schema + ' but no report');
    }
    // Bare report form: must carry the gate booleans.
    if (typeof doc.ok === 'boolean' && typeof doc.verified === 'boolean' &&
        Array.isArray(doc.violations)) {
        return doc;
    }
    // A summary, not a report.
    if (doc.patched !== undefined || doc.byRead !== undefined || doc.records !== undefined) {
        fail3('that is a summary, not a gate report. Gate it in the browser with ' +
            'checkNoReflow(summary, rules), serialise the result with formatJson, ' +
            'then feed that layout.json here. A summary has no verdict until rules apply.');
    }
    fail3('unrecognised document: ' + file + ' is neither a lite-layout-report/1 ' +
        'envelope nor a checkNoReflow report');
}

function fail3(msg) {
    process.stderr.write('lite-layout-gate: ' + msg + '\n');
    process.exit(3);
}

function main() {
    const args = parseArgs(process.argv.slice(2));

    let raw;
    try { raw = readFileSync(args.file, 'utf8'); }
    catch (e) { fail3('cannot read ' + args.file + ': ' + e.message); }

    let doc;
    try { doc = JSON.parse(raw); }
    catch (e) { fail3('invalid JSON in ' + args.file + ': ' + e.message); }

    const report = extractReport(doc, args.file);
    const verdict = _verdictOf(report);

    const rendered = FORMATTERS[args.format](report);
    process.stdout.write(rendered + '\n');

    if (args.out) {
        try { writeFileSync(args.out, formatJson(report) + '\n'); }
        catch (e) { fail3('cannot write --out ' + args.out + ': ' + e.message); }
    }

    if (verdict === 'pass') process.exit(0);
    if (verdict === 'fail') process.exit(1);
    // Inconclusive always exits 2, so CI can distinguish "could not verify" from
    // a real fail (1) and treat it as its policy prefers. --allow-inconclusive
    // is accepted for parity with lite-gc-gate but does not change this: an
    // inconclusive verdict is exit 2 either way.
    process.exit(2);
}

main();
