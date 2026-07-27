// @zakkster/lite-layout-profiler 1.3.0
// Dev-mode forced-reflow detector. Patches layout-triggering getters on
// Element/HTMLElement prototypes, tracks DOM writes that invalidate layout,
// and flags read-after-write within the same synchronous task. Attributes
// each violation to a call site via Error.stack.
//
// v1.1 adds the gate lane: checkNoReflow / assertNoReflow turn a recorded
// run into a pass/fail budget decision. The gate is fail-closed -- any rule
// it cannot verify from the data it was handed fails the run rather than
// passing it. Unknown rule keys throw with a did-you-mean hint.
//
// v1.2 adds the cost lane: each forced reflow is timed across the original
// getter, so the report carries milliseconds of stall and not just a count.
// A timer-resolution probe runs at init; any measurement that lands below
// the clock's granularity is reported as null, never as zero. Cost rules
// refuse to evaluate over unmeasured reflows.
//
// v1.3 adds the phase lane (opt-in via { phases: true }): each reflow is
// classified by the scheduler it fired under -- raf, timer, microtask,
// ro-callback, event -- so a frame-killing reflow inside requestAnimationFrame
// can be gated separately (maxInRaf) from a merely-bad one inside a timer. A
// phase we did not wrap is reported as 'unknown', never guessed. Thrash
// collapsing folds an identical read-after-write tuple repeating within one
// task into a single counted record (maxThrash), and ResizeObserver feedback
// loops are flagged.
//
// NOT zero-GC. This is a diagnostic tool that allocates per violation.
// Ship behind a __DEV__ flag or strip from production builds.
//
// Copyright (c) 2026 Zahary Shinikchiev <shinikchiev@yahoo.com>
// MIT License

export const VERSION = '1.3.0';

// ---------------------------------------------------------------------------
// Layout-triggering reads (the getters that force synchronous layout)
// ---------------------------------------------------------------------------

const ELEMENT_GETTERS = [
    'offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft',
    'clientWidth', 'clientHeight', 'clientTop', 'clientLeft',
    'scrollWidth', 'scrollHeight'
];

// scrollTop and scrollLeft are get/set -- we only patch the getter path.
const ELEMENT_GETSET = ['scrollTop', 'scrollLeft'];

// Reads that are not plain element getters: methods and window metrics.
const OTHER_READS = [
    'getBoundingClientRect()', 'getComputedStyle()',
    'getBBox()', 'getCTM()', 'getScreenCTM()',
    'scrollIntoView()', 'scrollTo()', 'scrollBy()', 'scroll()',
    'innerWidth', 'innerHeight', 'scrollX', 'scrollY',
    'pageXOffset', 'pageYOffset'
];

/**
 * The complete closed vocabulary of read names this build can emit.
 * Derived from the same lists the patcher uses, so it cannot drift out of
 * sync with what is actually instrumented. The gate validates `allowReads`
 * entries against this: a typo in an allowlist is a config error, not a
 * silently-ineffective filter.
 */
export const READ_NAMES = ELEMENT_GETTERS
    .concat(ELEMENT_GETSET)
    .concat(OTHER_READS);

// ---------------------------------------------------------------------------
// Layout-invalidating writes (common mutations that dirty layout)
// ---------------------------------------------------------------------------

// Each entry: [prototype, methodOrProp, kind]
// kind: 'method' = patch the function, 'setter' = patch the set descriptor.
// We patch the MOST COMMON paths. Exotic mutations (CSSOM insertRule,
// adoptedStyleSheets, etc.) are out of scope for a lightweight detector.

function buildWriteTargets() {
    var targets = [];

    // Style mutations
    if (typeof CSSStyleDeclaration !== 'undefined') {
        targets.push([CSSStyleDeclaration.prototype, 'setProperty', 'method']);
        targets.push([CSSStyleDeclaration.prototype, 'removeProperty', 'method']);
        targets.push([CSSStyleDeclaration.prototype, 'cssText', 'setter']);
    }

    // Class mutations
    if (typeof Element !== 'undefined') {
        targets.push([Element.prototype, 'className', 'setter']);
        targets.push([Element.prototype, 'setAttribute', 'method']);
        targets.push([Element.prototype, 'removeAttribute', 'method']);
        targets.push([Element.prototype, 'toggleAttribute', 'method']);
    }

    // classList mutations
    if (typeof DOMTokenList !== 'undefined') {
        targets.push([DOMTokenList.prototype, 'add', 'method']);
        targets.push([DOMTokenList.prototype, 'remove', 'method']);
        targets.push([DOMTokenList.prototype, 'toggle', 'method']);
        targets.push([DOMTokenList.prototype, 'replace', 'method']);
    }

    // DOM tree mutations
    if (typeof Node !== 'undefined') {
        targets.push([Node.prototype, 'appendChild', 'method']);
        targets.push([Node.prototype, 'insertBefore', 'method']);
        targets.push([Node.prototype, 'removeChild', 'method']);
        targets.push([Node.prototype, 'replaceChild', 'method']);
        targets.push([Node.prototype, 'textContent', 'setter']);
    }

    // innerHTML / innerText
    if (typeof Element !== 'undefined') {
        targets.push([Element.prototype, 'innerHTML', 'setter']);
        targets.push([Element.prototype, 'outerHTML', 'setter']);
    }
    if (typeof HTMLElement !== 'undefined') {
        targets.push([HTMLElement.prototype, 'innerText', 'setter']);
    }

    return targets;
}

// ---------------------------------------------------------------------------
// Stack parsing
// ---------------------------------------------------------------------------

function captureStack() {
    var obj = {};
    if (Error.captureStackTrace) {
        Error.captureStackTrace(obj, captureStack);
        return obj.stack || '';
    }
    return (new Error()).stack || '';
}

function parseStack(raw) {
    // Extract the first caller outside this module.
    var lines = raw.split('\n');
    for (var i = 1; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line.indexOf('LayoutProfiler') >= 0) continue;
        if (line.indexOf('lite-layout-profiler') >= 0) continue;
        if (line.indexOf('createLayoutProfiler') >= 0) continue;
        if (line.indexOf('markDirty') >= 0) continue;
        if (line.indexOf('onRead') >= 0) continue;
        if (line.indexOf('recordRead') >= 0) continue;
        if (line.indexOf('measuredGet') >= 0) continue;
        if (line.indexOf('underPhase') >= 0) continue;
        if (line.indexOf('measuredCall') >= 0) continue;
        if (line.length > 0) return line;
    }
    return lines[2] ? lines[2].trim() : '(unknown)';
}

// ---------------------------------------------------------------------------
// Clock and timer resolution (v1.2)
// ---------------------------------------------------------------------------

const clock = (typeof performance !== 'undefined' && performance.now)
    ? function () { return performance.now(); }
    : function () { return Date.now(); };

/**
 * Smallest positive delta the clock will report.
 *
 * Browsers deliberately coarsen performance.now(): a non-isolated Chrome tab
 * clamps to 100us, Firefox to 1ms by default. A forced reflow shorter than
 * that reads back as exactly 0, which is indistinguishable from free. We
 * measure the floor once so those measurements can be reported as null
 * instead of laundered into zero.
 *
 * Budgeted: at most `budgetMs` of wall time and 8 samples, so a coarse clock
 * costs a couple of milliseconds at init rather than fifty. Returns null when
 * no positive delta could be observed at all -- in which case every cost is
 * unmeasured and cost rules become unverifiable, which is the correct
 * fail-closed outcome.
 */
function probeResolution(budgetMs, clk) {
    var min = Infinity;
    var deadline = clk() + budgetMs;
    for (var i = 0; i < 8; i++) {
        var a = clk();
        var b = a;
        var spins = 0;
        while (b === a && spins < 200000) { b = clk(); spins++; }
        var d = b - a;
        if (d > 0 && d < min) min = d;
        if (clk() >= deadline) break;
    }
    return (min === Infinity || !isFinite(min)) ? null : min;
}

// ---------------------------------------------------------------------------
// Gate lane (v1.1)
//
// Vocabulary note, because two different things are called "violations" in
// this domain and conflating them is the easiest way to misread a report:
//
//   record    -- one recorded forced reflow (summary.records[i])
//   violation -- one breached gate rule   (checkNoReflow(...).violations[i])
//
// The gate report keeps the { metric, limit, actual, reason } violation shape
// used by lite-gc-profiler's checkNoGc so both profilers speak one language
// to lite-perf-gate and CI tooling.
// ---------------------------------------------------------------------------

const RULE_KEYS = [
    'maxReflows', 'maxPerTask', 'maxCostMs', 'maxTotalCostMs',
    'maxInRaf', 'maxThrash',
    'allowReads', 'allowWrites', 'ignoreSites'
];

// Rules that belong to lanes not yet shipped. Recognised so the error can say
// what is actually wrong instead of offering a nonsense spelling suggestion.
const FUTURE_RULE_KEYS = {
    allowExpected: ['1.5', 'expected-scope lane'],
    maxInTimer: ['later', 'a per-scheduler rule that is not yet gated separately -- '
        + 'see summary().phases.timer for the count'],
    maxInMicrotask: ['later', 'a per-scheduler rule that is not yet gated separately -- '
        + 'see summary().phases.microtask for the count']
};

export class ReflowBudgetError extends Error {
    constructor(report) {
        var lines = [];
        for (var i = 0; i < report.violations.length; i++) {
            var v = report.violations[i];
            lines.push('  - ' + v.reason);
        }
        super(
            '[lite-layout-profiler] Reflow budget exceeded (' +
            report.violations.length + ' rule' +
            (report.violations.length === 1 ? '' : 's') + ' breached):\n' +
            lines.join('\n')
        );
        this.name = 'ReflowBudgetError';
        this.report = report;
        this.violations = report.violations;
    }
}

function editDistance(a, b) {
    var m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    var prev = new Array(n + 1);
    var cur = new Array(n + 1);
    var i, j;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
        cur[0] = i;
        for (j = 1; j <= n; j++) {
            var cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
            var d = prev[j] + 1;
            var ins = cur[j - 1] + 1;
            if (ins < d) d = ins;
            var sub = prev[j - 1] + cost;
            if (sub < d) d = sub;
            cur[j] = d;
        }
        var swap = prev; prev = cur; cur = swap;
    }
    return prev[n];
}

// Closest known name within edit distance 2, case-insensitive exact first.
function suggest(key, known) {
    var lower = String(key).toLowerCase();
    var i;
    for (i = 0; i < known.length; i++) {
        if (known[i].toLowerCase() === lower) return known[i];
    }
    var best = null;
    var bestD = 3;
    for (i = 0; i < known.length; i++) {
        var d = editDistance(lower, known[i].toLowerCase());
        if (d < bestD) { bestD = d; best = known[i]; }
    }
    return best;
}

function hintFor(key, known) {
    var s = suggest(key, known);
    return s ? ' Did you mean `' + s + '`?' : '';
}

function requireCount(name, value) {
    if (typeof value !== 'number' || !isFinite(value) || value < 0) {
        throw new TypeError(
            '[lite-layout-profiler] Rule `' + name + '` must be a ' +
            'non-negative finite number, received ' +
            (typeof value === 'number' ? String(value) : typeof value) + '.'
        );
    }
}

function requireStringList(name, value) {
    if (!Array.isArray(value)) {
        throw new TypeError(
            '[lite-layout-profiler] Rule `' + name + '` must be an array of ' +
            'strings, received ' + (value === null ? 'null' : typeof value) + '.'
        );
    }
    for (var i = 0; i < value.length; i++) {
        if (typeof value[i] !== 'string') {
            throw new TypeError(
                '[lite-layout-profiler] Rule `' + name + '[' + i + ']` must be ' +
                'a string, received ' + typeof value[i] + '.'
            );
        }
    }
}

/**
 * A cost is a measurement only if it is a finite, non-negative number.
 *
 * `typeof NaN === 'number'` is the trap here: NaN compares false against every
 * limit, so treating it as measured would let a corrupted or hostile report
 * pass any cost budget in silence. Infinity and negatives (a non-monotonic
 * clock) are rejected for the same reason -- they are not durations.
 */
function isMeasuredCost(v) {
    return typeof v === 'number' && isFinite(v) && v >= 0;
}

// The structural fields any per-record rule needs to exist before it can
// reason about a record at all.
function recordIsWellFormed(rec) {
    return rec !== null && typeof rec === 'object' && !Array.isArray(rec) &&
        typeof rec.read === 'string' &&
        typeof rec.write === 'string' &&
        typeof rec.readSite === 'string' &&
        typeof rec.writeSite === 'string' &&
        typeof rec.taskId === 'number' && isFinite(rec.taskId);
}

// A read name with any trailing "()" removed, so `allowReads` accepts both
// 'getBoundingClientRect' and 'getBoundingClientRect()'.
function bareRead(name) {
    return name.slice(-2) === '()' ? name.slice(0, -2) : name;
}

function validateRules(rules) {
    var keys = Object.keys(rules);
    var i;
    for (i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (RULE_KEYS.indexOf(k) >= 0) continue;
        if (Object.prototype.hasOwnProperty.call(FUTURE_RULE_KEYS, k)) {
            var f = FUTURE_RULE_KEYS[k];
            throw new TypeError(
                '[lite-layout-profiler] Rule `' + k + '` requires the ' + f[1] +
                ' (v' + f[0] + '+). This build is ' + VERSION + '.'
            );
        }
        throw new TypeError(
            '[lite-layout-profiler] Unknown gate rule `' + k + '`.' +
            hintFor(k, RULE_KEYS) +
            ' Known rules: ' + RULE_KEYS.join(', ') + '.'
        );
    }

    if (rules.maxReflows !== undefined) requireCount('maxReflows', rules.maxReflows);
    if (rules.maxPerTask !== undefined) requireCount('maxPerTask', rules.maxPerTask);
    if (rules.maxCostMs !== undefined) requireCount('maxCostMs', rules.maxCostMs);
    if (rules.maxTotalCostMs !== undefined) requireCount('maxTotalCostMs', rules.maxTotalCostMs);
    if (rules.maxInRaf !== undefined) requireCount('maxInRaf', rules.maxInRaf);
    if (rules.maxThrash !== undefined) requireCount('maxThrash', rules.maxThrash);
    if (rules.allowReads !== undefined) requireStringList('allowReads', rules.allowReads);
    if (rules.allowWrites !== undefined) requireStringList('allowWrites', rules.allowWrites);
    if (rules.ignoreSites !== undefined) requireStringList('ignoreSites', rules.ignoreSites);

    // An allowlist entry that matches nothing in the closed read vocabulary is
    // a typo, and a typo here silently widens nothing while looking like it
    // widened something. Reject it the same way an unknown rule key is rejected.
    if (rules.allowReads) {
        var bare = [];
        for (i = 0; i < READ_NAMES.length; i++) bare.push(bareRead(READ_NAMES[i]));
        for (i = 0; i < rules.allowReads.length; i++) {
            var entry = bareRead(rules.allowReads[i]);
            if (bare.indexOf(entry) >= 0) continue;
            throw new TypeError(
                '[lite-layout-profiler] `allowReads` entry `' +
                rules.allowReads[i] + '` is not a read this build can emit.' +
                hintFor(entry, bare) +
                ' See the READ_NAMES export for the full vocabulary.'
            );
        }
    }
}

function unverifiable(out, metric, actual, reason) {
    out.verified = false;
    out.ok = false;
    out.violations.push({
        metric: metric, limit: null, actual: actual, reason: reason
    });
}

/**
 * Evaluate a recorded run against a reflow budget.
 *
 * Fail-closed: every rule that needs per-record data states that need up
 * front, and if the summary cannot supply it -- records truncated by the
 * storage cap, or call sites absent because captureStacks was off -- the
 * rule fails as unverifiable rather than passing on incomplete evidence.
 * Zero counted reflows through a torn record set is not a clean run.
 *
 * @param {ViolationSummary} summary  from profiler.summary()
 * @param {object} [rules]
 * @returns {GateReport}
 */
export function checkNoReflow(summary, rules) {
    if (summary === null || typeof summary !== 'object') {
        throw new TypeError(
            '[lite-layout-profiler] checkNoReflow expects a summary object ' +
            'from profiler.summary(), received ' +
            (summary === null ? 'null' : typeof summary) + '.'
        );
    }
    if (rules !== undefined && rules !== null &&
        (typeof rules !== 'object' || Array.isArray(rules))) {
        throw new TypeError(
            '[lite-layout-profiler] checkNoReflow expects a rules object, ' +
            'received ' + (Array.isArray(rules) ? 'an array' : typeof rules) + '.'
        );
    }
    // Own enumerable properties only. Validation walks Object.keys, so reading
    // rule values through a prototype chain would apply limits that were never
    // validated -- Object.create({ maxReflows: -5 }) would sail straight past.
    var r = Object.create(null);
    var given = rules || {};
    var gk = Object.keys(given);
    for (var gi = 0; gi < gk.length; gi++) r[gk[gi]] = given[gk[gi]];
    validateRules(r);

    var maxReflows = r.maxReflows === undefined ? 0 : r.maxReflows;
    var maxPerTask = r.maxPerTask === undefined ? Infinity : r.maxPerTask;
    var maxCostMs = r.maxCostMs === undefined ? Infinity : r.maxCostMs;
    var maxTotalCostMs = r.maxTotalCostMs === undefined ? Infinity : r.maxTotalCostMs;
    var maxInRaf = r.maxInRaf === undefined ? Infinity : r.maxInRaf;
    var maxThrash = r.maxThrash === undefined ? Infinity : r.maxThrash;
    var allowReads = r.allowReads || [];
    var allowWrites = r.allowWrites || [];
    var ignoreSites = r.ignoreSites || [];

    var total = summary.total;
    var totalUsable = typeof total === 'number' && isFinite(total) &&
        total >= 0 && Math.floor(total) === total;
    if (!totalUsable) total = 0;

    var out = {
        ok: true,
        verified: true,
        total: total,
        counted: total,
        excluded: 0,
        excludedBy: { reads: 0, writes: 0, sites: 0 },
        cost: null,
        violations: []
    };

    // Coverage is checked before anything else, because it invalidates every
    // rule at once rather than one of them. A read that was never patched
    // cannot appear in `total`, so even the exact count is a floor and not a
    // number. Absent `patched` means a pre-1.2 summary, which is gated as
    // before rather than failed for lacking a field its build never emitted.
    var patched = summary.patched;
    if (patched && typeof patched === 'object' && patched.complete === false) {
        unverifiable(out, 'patched',
            patched.failed + ' of ' + (patched.applied + patched.failed) + ' failed',
            'The profiler could not instrument ' + patched.failed + ' target' +
            (patched.failed === 1 ? '' : 's') +
            ' on this host, so reflows through those paths were never seen' +
            (patched.failures && patched.failures.length
                ? ' (' + patched.failures.slice(0, 3).join(', ') +
                  (patched.failures.length > 3 ? ', ...' : '') + ')'
                : '') +
            '. A count taken through a torn net is a floor, not a total.');
    }

    if (!totalUsable) {
        unverifiable(out, 'total', String(summary.total),
            'summary.total is not a count. A verdict needs an exact number of ' +
            'reflows to reason from; this summary does not carry one.');
    }

    var needsCost = maxCostMs !== Infinity || maxTotalCostMs !== Infinity;
    var needsPhase = maxInRaf !== Infinity;
    var needsThrash = maxThrash !== Infinity;
    var hasAllowlist =
        allowReads.length > 0 || allowWrites.length > 0 || ignoreSites.length > 0;
    var needsRecords = hasAllowlist || maxPerTask !== Infinity || needsCost ||
        needsPhase || needsThrash;
    var records = Array.isArray(summary.records) ? summary.records : null;

    // -- Evidence checks, before any counting --

    if (needsRecords && records === null) {
        unverifiable(out, 'records', 'absent',
            'Rules requiring per-record data were set, but the summary ' +
            'carries no `records` array (summary from a pre-1.1 build?).');
    }
    if (needsRecords && records !== null) {
        var malformed = 0;
        for (var mi = 0; mi < records.length; mi++) {
            if (!recordIsWellFormed(records[mi])) malformed++;
        }
        if (malformed > 0) {
            unverifiable(out, 'records', malformed + ' malformed',
                malformed + ' of ' + records.length + ' records are missing ' +
                'fields the requested rules read. A partially-readable record ' +
                'set cannot be counted over.');
        } else if (totalUsable && records.length > total) {
            // More records than the run claims to have produced. One of the
            // two numbers is wrong and there is no way to tell which.
            unverifiable(out, 'records',
                records.length + ' > ' + total,
                'summary carries more records (' + records.length + ') than ' +
                'its own total (' + total + '). The report is internally ' +
                'inconsistent and cannot be gated.');
        }
    }
    if (needsRecords && summary.truncated === true) {
        unverifiable(out, 'records',
            summary.stored + '/' + total,
            'Records were truncated by the storage cap (' + summary.stored +
            ' of ' + total + ' kept), so per-record rules cannot be evaluated ' +
            'over the whole run. Raise `maxStored` or lower the reflow count.');
    }
    if (ignoreSites.length > 0 && summary.stacks === false) {
        unverifiable(out, 'ignoreSites', 'no call sites',
            '`ignoreSites` needs call sites, but the run was recorded with ' +
            'captureStacks: false.');
    }

    // -- Exclusion pass --

    var kept = null;
    if (records !== null && out.verified) {
        kept = [];
        var bareAllowed = [];
        var i, j;
        for (i = 0; i < allowReads.length; i++) bareAllowed.push(bareRead(allowReads[i]));

        for (i = 0; i < records.length; i++) {
            var rec = records[i];
            var why = '';

            if (bareAllowed.indexOf(bareRead(rec.read)) >= 0) {
                why = 'reads';
            } else {
                for (j = 0; j < allowWrites.length; j++) {
                    // Prefix match: 'CSSStyleDeclaration.' allows every style
                    // write; 'Element.className =' allows exactly that one.
                    if (rec.write.indexOf(allowWrites[j]) === 0) { why = 'writes'; break; }
                }
            }
            if (why === '') {
                for (j = 0; j < ignoreSites.length; j++) {
                    var pat = ignoreSites[j];
                    if (rec.readSite.indexOf(pat) >= 0 || rec.writeSite.indexOf(pat) >= 0) {
                        why = 'sites'; break;
                    }
                }
            }

            if (why === '') kept.push(rec);
            else { out.excluded++; out.excludedBy[why]++; }
        }
        out.counted = total - out.excluded;
        if (out.counted < 0) out.counted = 0;
    }

    // -- Rule evaluation --

    if (out.counted > maxReflows) {
        out.ok = false;
        out.violations.push({
            metric: 'maxReflows',
            limit: maxReflows,
            actual: out.counted,
            reason: 'maxReflows: ' + out.counted + ' forced reflow' +
                (out.counted === 1 ? '' : 's') + ' counted, limit ' + maxReflows +
                (out.excluded > 0 ? ' (' + out.excluded + ' excluded by allowlist)' : '')
        });
    }

    if (maxPerTask !== Infinity && kept !== null) {
        var worst = 0;
        var worstTask = -1;
        var counts = new Map();
        for (var k = 0; k < kept.length; k++) {
            var t = kept[k].taskId;
            var c = (counts.get(t) || 0) + 1;
            counts.set(t, c);
            if (c > worst) { worst = c; worstTask = t; }
        }
        if (worst > maxPerTask) {
            out.ok = false;
            out.violations.push({
                metric: 'maxPerTask',
                limit: maxPerTask,
                actual: worst,
                reason: 'maxPerTask: task #' + worstTask + ' forced ' + worst +
                    ' reflows in one synchronous block, limit ' + maxPerTask
            });
        }
    }

    // -- Cost lane --
    //
    // A reflow whose stall landed below the clock's granularity has no
    // number, only an upper bound. Summing nulls as zeroes would let a
    // thousand sub-resolution stalls pass a millisecond budget, so cost
    // rules refuse to evaluate over them at all.

    if (kept !== null) {
        var measured = 0, unmeasured = 0;
        var totalMs = 0, maxMs = 0, worstSite = '';
        for (var c = 0; c < kept.length; c++) {
            var cost = kept[c].costMs;
            if (!isMeasuredCost(cost)) { unmeasured++; continue; }
            measured++;
            totalMs += cost;
            if (cost > maxMs) { maxMs = cost; worstSite = kept[c].readSite; }
        }
        out.cost = {
            measured: measured,
            unmeasured: unmeasured,
            // Null is not zero: with nothing measured there is no total.
            totalMs: measured > 0 ? totalMs : null,
            maxMs: measured > 0 ? maxMs : null
        };

        if (needsCost && unmeasured > 0) {
            var res = summary.cost && typeof summary.cost.resolutionMs === 'number'
                ? summary.cost.resolutionMs : null;
            unverifiable(out, 'cost', unmeasured + ' unmeasured',
                unmeasured + ' of ' + kept.length + ' counted reflow' +
                (kept.length === 1 ? '' : 's') + ' carry no cost' +
                (res === null
                    ? ', because the timer resolution could not be determined ' +
                      '(or the run was recorded with measureCost: false).'
                    : ', having landed below the ' + res + ' ms timer resolution. ' +
                      'Gate on counts instead, or raise the workload so each stall ' +
                      'clears the clock.'));
        }

        if (needsCost && measured > 0 && out.verified) {
            if (maxMs > maxCostMs) {
                out.ok = false;
                out.violations.push({
                    metric: 'maxCostMs',
                    limit: maxCostMs,
                    actual: maxMs,
                    reason: 'maxCostMs: worst single forced reflow stalled ' +
                        maxMs.toFixed(3) + ' ms, limit ' + maxCostMs + ' ms' +
                        (worstSite ? ' (' + worstSite.trim() + ')' : '')
                });
            }
            if (totalMs > maxTotalCostMs) {
                out.ok = false;
                out.violations.push({
                    metric: 'maxTotalCostMs',
                    limit: maxTotalCostMs,
                    actual: totalMs,
                    reason: 'maxTotalCostMs: ' + measured + ' forced reflows stalled ' +
                        totalMs.toFixed(3) + ' ms in total, limit ' +
                        maxTotalCostMs + ' ms'
                });
            }
        }
    }

    // -- Phase lane (maxInRaf) --
    //
    // A reflow inside a requestAnimationFrame callback stalls the exact frame
    // it is trying to render. maxInRaf: 0 asserts "never force layout during
    // render". It is unverifiable if the phase wrappers were not installed:
    // you cannot claim no reflow in rAF if rAF was never watched.
    if (needsPhase && kept !== null) {
        if (summary.phasesObserved !== true) {
            unverifiable(out, 'maxInRaf', 'phases not observed',
                'maxInRaf needs the phase lane, but this run was recorded ' +
                'without it. Create the profiler with { phases: true }.');
        } else {
            var inRaf = 0;
            for (var pk = 0; pk < kept.length; pk++) {
                if (kept[pk].phase === 'raf') inRaf++;
            }
            if (inRaf > maxInRaf) {
                out.ok = false;
                out.violations.push({
                    metric: 'maxInRaf',
                    limit: maxInRaf,
                    actual: inRaf,
                    reason: 'maxInRaf: ' + inRaf + ' forced reflow' +
                        (inRaf === 1 ? '' : 's') + ' inside requestAnimationFrame ' +
                        'callbacks (frame-killing), limit ' + maxInRaf
                });
            }
        }
    }

    // -- Thrash lane (maxThrash) --
    //
    // The worst collapsed (read, write, site, site, task) count. maxThrash: 1
    // means no read-after-write tuple may repeat within a block -- the
    // signature of a getter read in a loop. Uses the precomputed
    // summary.maxThrashCount, which is derived from the same records; a
    // truncated run makes it a floor, so it fails as unverifiable there
    // (handled by the records-evidence checks above).
    if (maxThrash !== Infinity) {
        if (typeof summary.maxThrashCount !== 'number') {
            unverifiable(out, 'maxThrash', 'no thrash data',
                'maxThrash needs the collapsed thrash view, absent from this ' +
                'summary (a pre-1.3 build?).');
        } else if (out.verified) {
            var worstThrash = summary.maxThrashCount;
            if (worstThrash > maxThrash) {
                out.ok = false;
                var worstGroup = Array.isArray(summary.thrash) && summary.thrash.length > 0
                    ? summary.thrash[0] : null;
                out.violations.push({
                    metric: 'maxThrash',
                    limit: maxThrash,
                    actual: worstThrash,
                    reason: 'maxThrash: a read-after-write tuple repeated ' +
                        worstThrash + ' times in one block, limit ' + maxThrash +
                        (worstGroup ? ' (read `' + worstGroup.read + '` after `' +
                            worstGroup.write + '`)' : '')
                });
            }
        }
    }

    return out;
}

/**
 * checkNoReflow, but throws ReflowBudgetError when the budget is breached.
 * @param {ViolationSummary} summary
 * @param {object} [rules]
 * @returns {GateReport} the passing report
 */
export function assertNoReflow(summary, rules) {
    var report = checkNoReflow(summary, rules);
    if (!report.ok) throw new ReflowBudgetError(report);
    return report;
}

// ---------------------------------------------------------------------------
// createLayoutProfiler -- the public API
// ---------------------------------------------------------------------------

// Upper bound on the record ring. Past this, a cap is not a diagnostic
// choice; it is a mistyped number.
const MAX_STORED = 1000000;

function resolveCap(opts) {
    var raw, name;
    if (opts.maxStored !== undefined) { raw = opts.maxStored; name = 'maxStored'; }
    else if (opts.maxViolations !== undefined) { raw = opts.maxViolations; name = 'maxViolations'; }
    else return 200;

    if (typeof raw !== 'number' || !isFinite(raw) ||
        Math.floor(raw) !== raw || raw < 1 || raw > MAX_STORED) {
        throw new TypeError(
            '[lite-layout-profiler] `' + name + '` must be an integer between 1 and ' +
            MAX_STORED + ', received ' +
            (typeof raw === 'number' ? String(raw) : typeof raw) + '.'
        );
    }
    return raw;
}

/**
 * @param {object} [options]
 * @param {number} [options.maxStored=200]
 *   Cap on stored violations. Older violations are dropped when full.
 * @param {(v: Violation) => void} [options.onViolation]
 *   Called on each forced reflow. Receives the violation object.
 * @param {boolean} [options.captureStacks=true]
 *   Capture call stacks for attribution. Set false to reduce overhead.
 * @param {boolean} [options.warnToConsole=true]
 *   Log a console.warn on each violation.
 * @param {string[]} [options.ignorePatterns]
 *   Stack frame substrings to ignore (e.g. library internals).
 * @returns {LayoutProfiler}
 */
export function createLayoutProfiler(options) {
    if (typeof Element === 'undefined') {
        // Non-browser environment: return a no-op profiler. Its summary is a
        // real, gate-shaped summary of an empty run -- v1.0 omitted summary()
        // here entirely, which made `profiler.summary()` throw under node.
        return {
            violations: [], violationCount: 0,
            destroy: function () {}, reset: function () {},
            get active() { return false; },
            summary: function () {
                return {
                    total: 0, stored: 0, truncated: false, stacks: false,
                    patched: { applied: 0, failed: 0, skipped: 0, complete: false,
                        failures: ['no DOM in this environment'] },
                    byRead: {}, byWrite: {}, byTask: {}, taskCount: 0,
                    phases: { raf: 0, timer: 0, microtask: 0, roCallback: 0,
                        event: 0, unknown: 0, unobserved: 0 },
                    phasesObserved: false,
                    thrash: [], maxThrashCount: 0,
                    cost: {
                        resolutionMs: null, measured: 0, unmeasured: 0,
                        totalMs: null, maxMs: null, avgMs: null, p99Ms: null
                    },
                    records: []
                };
            }
        };
    }

    var opts = options || {};
    // `maxStored` is the storage cap. The v1.0 name for it was `maxViolations`,
    // which collides head-on with the gate rule of the same name meaning the
    // opposite thing (a budget of zero, not a buffer of 200). Both are accepted;
    // maxStored is the name going forward.
    //
    // Validated rather than coerced. `maxStored: 0` under a `||` chain silently
    // becomes 200, a fractional cap makes `new Array()` throw, and an
    // astronomical one buys a dictionary-mode array nobody asked for. Each of
    // those is a typo, and a typo in a diagnostic tool should say so.
    var maxViolations = resolveCap(opts);
    var onViolation = typeof opts.onViolation === 'function' ? opts.onViolation : null;
    var captureStacks = opts.captureStacks !== false;
    var measureCost = opts.measureCost !== false;
    // Phase lane (v1.3): wrap the schedulers so a reflow can be attributed to
    // the callback it fired under (raf, timer, microtask, ro-callback). Opt-in,
    // because wrapping requestAnimationFrame et al. touches globals other code
    // depends on and adds a push/pop around every scheduled callback in the
    // page, not just the ones that force layout -- a broader footprint than the
    // read/write prototype patches. With it off, every record is phase
    // 'unobserved' and maxInRaf gates as unverifiable: you cannot assert "no
    // reflow in rAF" if you never watched rAF.
    var trackPhases = opts.phases === true;
    // Monotonic millisecond clock. Defaults to performance.now(). Overridable
    // for environments without it, and so tests can drive a clock with known
    // granularity instead of hoping the host's happens to be coarse.
    //
    // Only adopted when the cost lane is on: `clock` exists to serve cost
    // measurement, so with `measureCost: false` there is nothing for it to do,
    // and a caller who has switched timing off should not still be exposed to
    // a clock that throws.
    var clk = (measureCost && typeof opts.clock === 'function') ? opts.clock : clock;
    var warnToConsole = opts.warnToConsole !== false;
    var ignorePatterns = opts.ignorePatterns || [];

    // Records live in a fixed-size ring. v1.1 used a plain array with shift()
    // on overflow, which is O(N) per drop once the buffer is full -- a real
    // cost in exactly the thrashing runs this tool is pointed at. The ring
    // writes in place and never moves an element.
    var cap = maxViolations > 0 ? maxViolations : 1;
    var ring = new Array(cap);
    var ringWrite = 0;
    var ringCount = 0;
    var violationsCache = null;
    var violationCount = 0;
    var active = true;

    // Timer floor, probed once. Null means "cannot tell", not "zero".
    var resolutionMs = measureCost ? probeResolution(2, clk) : null;

    function pushRecord(v) {
        ring[ringWrite] = v;
        ringWrite = ringWrite + 1 === cap ? 0 : ringWrite + 1;
        if (ringCount < cap) ringCount++;
        violationsCache = null;
    }

    // Walks retained records oldest-first regardless of where the ring wrapped.
    function forEachRecord(fn) {
        var start = ringCount < cap ? 0 : ringWrite;
        for (var i = 0; i < ringCount; i++) {
            var idx = start + i;
            if (idx >= cap) idx -= cap;
            fn(ring[idx]);
        }
    }

    // -- dirty tracking --
    // Set to a string (the write source) on layout-invalidating writes.
    // Cleared at the end of the current microtask checkpoint.
    var dirty = null;
    var dirtySource = '';
    var dirtyStack = '';
    var cleanupScheduled = false;

    // Monotonic epoch identifying the synchronous block a record belongs to.
    // Advanced by the same microtask checkpoint that clears the dirty flag,
    // so every record captured between two checkpoints shares a taskId. This
    // is what makes `maxPerTask` meaningful: ten reflows spread over ten
    // frames is a different illness from ten in one block.
    var taskEpoch = 0;

    // Phase lane state (v1.3). currentPhase is the top of a small stack the
    // scheduler wrappers push/pop. 'unobserved' is the value when phase
    // tracking is off entirely; 'unknown' is the value when tracking is ON but
    // the read fired outside any scheduler we wrapped (a foreign rAF shim, a
    // native event dispatch we cannot see). The distinction matters: unobserved
    // means "we did not look", unknown means "we looked and this path was not
    // one we watch". Neither is ever guessed into 'raf'.
    var phaseStack = [];
    var currentPhase = trackPhases ? 'unknown' : 'unobserved';
    var inRoCallback = false;   // true while a ResizeObserver callback runs
    var roWroteThisCallback = false;

    function pushPhase(name) {
        phaseStack.push(currentPhase);
        currentPhase = name;
    }
    function popPhase() {
        currentPhase = phaseStack.length > 0 ? phaseStack.pop() : 'unknown';
    }

    function scheduleClear() {
        if (cleanupScheduled) return;
        cleanupScheduled = true;
        // queueMicrotask fires after the current synchronous block but
        // before the next task. Any read-after-write within the same
        // synchronous execution will see dirty = true.
        queueMicrotask(function () {
            dirty = null;
            dirtySource = '';
            dirtyStack = '';
            cleanupScheduled = false;
            taskEpoch++;
        });
    }

    function markDirty(source) {
        if (!active) return;
        dirty = source;
        dirtySource = source;
        if (captureStacks) dirtyStack = captureStack();
        // If a write happens while a ResizeObserver callback is running, note
        // it: a subsequent forced read in the same callback is the signature of
        // an RO feedback loop (write -> layout dirty -> observer refires).
        if (inRoCallback) roWroteThisCallback = true;
        scheduleClear();
    }

    function shouldIgnore(stack) {
        for (var i = 0; i < ignorePatterns.length; i++) {
            if (stack.indexOf(ignorePatterns[i]) >= 0) return true;
        }
        return false;
    }

    // True when a read happening right now would force a synchronous layout.
    // Checked before the clock is touched so clean reads pay one comparison
    // and nothing else.
    function armed() {
        return active && dirty !== null;
    }

    /**
     * Record a forced reflow. `elapsedMs` is the wall time spent inside the
     * original getter -- the stall itself, not the bookkeeping around it.
     *
     * A delta below the probed timer resolution is not a small number, it is
     * an absent one: the clock cannot distinguish it from zero. It is stored
     * as null with belowGranularity set, and the gate refuses to run cost
     * rules over it.
     */
    function recordRead(prop, elapsedMs) {
        var readStack = captureStacks ? captureStack() : '';
        if (shouldIgnore(readStack)) { dirty = null; return; }

        // Strictly greater, not >=. A delta of exactly one tick means the
        // true duration lies somewhere in (0, 2 * tick) -- an interval that
        // contains zero, so it is not evidence of any stall at all. Only from
        // two ticks up does the measurement carry a positive lower bound.
        var below = false;
        var costMs = null;
        if (resolutionMs !== null && isMeasuredCost(elapsedMs)) {
            if (elapsedMs > resolutionMs) costMs = elapsedMs;
            else below = true;
        }

        violationCount++;
        var v = {
            id: violationCount,
            taskId: taskEpoch,
            read: prop,
            write: dirtySource,
            readSite: captureStacks ? parseStack(readStack) : '(stacks disabled)',
            writeSite: captureStacks ? parseStack(dirtyStack) : '(stacks disabled)',
            readStack: readStack,
            writeStack: dirtyStack,
            costMs: costMs,
            belowGranularity: below,
            // Phase lane (v1.3). The scheduler this read fired under. See the
            // pushPhase/popPhase wrappers; 'unobserved' when phases:false.
            phase: currentPhase,
            // True when this reflow happened inside a ResizeObserver callback
            // whose body had already written layout -- the shape of an RO
            // feedback loop, where the write dirties layout and forces the
            // observer to refire.
            roFeedback: inRoCallback && roWroteThisCallback,
            // Thrash-collapse fields. A raw record is always count 1; collapsing
            // into groups with count > 1 happens at summary() time, never on
            // this hot path (a map lookup per violation would defeat the ring).
            count: 1,
            firstTimestamp: 0,   // filled at summary time for collapsed groups
            lastTimestamp: 0,
            unmeasuredMembers: 0,
            timestamp: clk()
        };

        pushRecord(v);

        // Clear before any user code runs, not after.
        //
        // The layout HAS been recalculated by this point, so the flag is stale
        // either way -- but the ordering is what makes reentrancy safe. A
        // callback that reads a layout property would otherwise see the flag
        // still set, record a violation of its own, and call itself: unbounded
        // recursion triggered by nothing worse than a debug overlay. A callback
        // that throws would strand the flag and turn every later read in the
        // task into a phantom violation. Both disappear if the profiler
        // finishes its own bookkeeping before handing control away.
        dirty = null;

        if (onViolation !== null) onViolation(v);
        if (warnToConsole) {
            console.warn(
                '[lite-layout-profiler] Forced reflow #' + violationCount +
                ': read `' + prop + '` after `' + dirtySource + '`' +
                (costMs === null
                    ? '\n  cost:     below timer resolution'
                    : '\n  cost:     ' + costMs.toFixed(3) + ' ms') +
                '\n  read at:  ' + v.readSite +
                '\n  write at: ' + v.writeSite
            );
        }

    }

    // Wrap a zero-argument layout getter so the stall inside it is timed.
    function measuredGet(originalGet, name) {
        return function () {
            if (!armed()) return originalGet.call(this);
            var t0 = clk();
            var value = originalGet.call(this);
            recordRead(name, clk() - t0);
            return value;
        };
    }

    // Wrap a layout-forcing method. `fixedThis` pins the receiver for
    // window-level functions; element methods keep their own `this`.
    function measuredCall(original, name, fixedThis) {
        return function () {
            if (!armed()) {
                return original.apply(fixedThis === undefined ? this : fixedThis, arguments);
            }
            var t0 = clk();
            var value = original.apply(fixedThis === undefined ? this : fixedThis, arguments);
            recordRead(name, clk() - t0);
            return value;
        };
    }

    // -----------------------------------------------------------------------
    // Patching
    // -----------------------------------------------------------------------

    var patches = [];

    // Patch coverage. A host can refuse to be patched -- frozen prototypes,
    // non-configurable descriptors, a hardened environment -- and a detector
    // with holes in its net reports zero reflows for the same reason a working
    // one does. Counting what actually landed is what lets the gate tell those
    // two zeroes apart.
    var patchApplied = 0;
    var patchFailed = 0;
    var patchSkipped = 0;
    var patchFailures = [];

    // Three outcomes, and the middle one is why this is not a boolean.
    //
    //   true       instrumented
    //   'absent'   nothing here to instrument -- no DOMTokenList, no SVG, an
    //              older engine. Not a hole: nothing can flow through a path
    //              the host does not have.
    //   false      present and refused -- frozen, non-configurable. A real
    //              hole: reflows can travel this path unseen.
    //
    // Collapsing 'absent' into false would make every minimal host look torn,
    // which is how a coverage check turns into noise everyone learns to ignore.
    function attempt(label, fn) {
        var r;
        try { r = fn(); } catch (e) { r = false; }
        if (r === 'absent') { patchSkipped++; return false; }
        if (r === false) {
            patchFailed++;
            if (patchFailures.length < 20) patchFailures.push(label);
            return false;
        }
        patchApplied++;
        return true;
    }

    // Patch a method: wrap it to call markDirty before the original.
    function patchMethod(proto, name, source) {
        var original = proto[name];
        if (typeof original !== 'function') return 'absent';
        var desc = Object.getOwnPropertyDescriptor(proto, name);
        if (desc && !desc.configurable && !desc.writable) return false;
        var wrapper = function () {
            markDirty(source + '.' + name + '()');
            return original.apply(this, arguments);
        };
        proto[name] = wrapper;
        // Restore only what is still ours. If another instrumenter patched on
        // top of us, its wrapper is what sits there now, and blindly writing
        // back our saved original would silently delete their patch.
        patches.push(function () {
            if (proto[name] === wrapper) proto[name] = original;
        });
        return true;
    }

    // Patch a setter: wrap set to call markDirty, keep get unchanged.
    function patchSetter(proto, name, source) {
        var desc = Object.getOwnPropertyDescriptor(proto, name);
        if (!desc || !desc.set) return 'absent';
        if (!desc.configurable) return false;
        var originalSet = desc.set;
        var originalGet = desc.get;
        var wrapSet = function (v) {
            markDirty(source + '.' + name + ' =');
            return originalSet.call(this, v);
        };
        Object.defineProperty(proto, name, {
            get: originalGet,
            set: wrapSet,
            enumerable: desc.enumerable,
            configurable: true
        });
        patches.push(function () {
            var cur = Object.getOwnPropertyDescriptor(proto, name);
            if (cur && cur.set === wrapSet) Object.defineProperty(proto, name, desc);
        });
        return true;
    }

    // Patch a getter to call onRead when dirty.
    function patchGetter(proto, name) {
        var desc = Object.getOwnPropertyDescriptor(proto, name);
        if (!desc || !desc.get) return 'absent';
        if (!desc.configurable) return false;
        var originalGet = desc.get;
        var originalSet = desc.set;
        var wrapGet = measuredGet(originalGet, name);
        var newDesc = {
            get: wrapGet,
            enumerable: desc.enumerable,
            configurable: true
        };
        if (originalSet) newDesc.set = originalSet;
        Object.defineProperty(proto, name, newDesc);
        patches.push(function () {
            var cur = Object.getOwnPropertyDescriptor(proto, name);
            if (cur && cur.get === wrapGet) Object.defineProperty(proto, name, desc);
        });
        return true;
    }

    // Patch getBoundingClientRect.
    function patchBCR() {
        var original = Element.prototype.getBoundingClientRect;
        if (typeof original !== 'function') return 'absent';
        var wrapBcr = measuredCall(original, 'getBoundingClientRect()');
        Element.prototype.getBoundingClientRect = wrapBcr;
        patches.push(function () {
            if (Element.prototype.getBoundingClientRect === wrapBcr) {
                Element.prototype.getBoundingClientRect = original;
            }
        });
        return true;
    }

    // Patch getComputedStyle.
    function patchGCS() {
        if (typeof window === 'undefined') return 'absent';
        var original = window.getComputedStyle;
        if (typeof original !== 'function') return 'absent';
        var wrapGcs = measuredCall(original, 'getComputedStyle()', window);
        window.getComputedStyle = wrapGcs;
        patches.push(function () {
            if (window.getComputedStyle === wrapGcs) window.getComputedStyle = original;
        });
        return true;
    }

    // Patch SVG layout-triggering reads. Anything measured against the SVG
    // coordinate space forces layout the same way getBoundingClientRect does.
    // Essential for reactive charting / dataviz code that reads geometry to
    // position tooltips or hit-test paths.
    function patchSvgReads() {
        if (typeof SVGGraphicsElement === 'undefined') return 'absent';
        var proto = SVGGraphicsElement.prototype;
        var names = ['getBBox', 'getCTM', 'getScreenCTM'];
        for (var i = 0; i < names.length; i++) {
            (function (name) {
                var original = proto[name];
                if (typeof original !== 'function') return;
                var w = measuredCall(original, name + '()');
                proto[name] = w;
                patches.push(function () {
                    if (proto[name] === w) proto[name] = original;
                });
            }(names[i]));
        }
        return true;
    }

    // Patch scroll-positioning methods. These are hybrid: they mutate scroll
    // position (a write) but must first compute layout to know where to
    // scroll to (a read). Treated as reads because that's the perf-relevant
    // half; a wrote-then-scrolled sequence is the exact anti-pattern the tool
    // exists to catch. Scroll changes themselves don't invalidate layout
    // (only paint), so we don't markDirty afterwards.
    function patchScrollMethods() {
        var targets = [];
        if (typeof Element !== 'undefined') {
            targets.push([Element.prototype, 'scrollIntoView']);
            targets.push([Element.prototype, 'scrollTo']);
            targets.push([Element.prototype, 'scrollBy']);
        }
        if (typeof window !== 'undefined') {
            targets.push([window, 'scrollTo']);
            targets.push([window, 'scrollBy']);
            targets.push([window, 'scroll']);
        }
        for (var i = 0; i < targets.length; i++) {
            (function (obj, name) {
                var original = obj[name];
                if (typeof original !== 'function') return;
                var w = measuredCall(original, name + '()');
                obj[name] = w;
                patches.push(function () {
                    if (obj[name] === w) obj[name] = original;
                });
            }(targets[i][0], targets[i][1]));
        }
        return true;
    }

    // Patch window-level metric getters. scrollY / scrollX / pageOffset can
    // force reflow after DOM writes (browser must know current scroll extent);
    // innerWidth / innerHeight may or may not depending on browser -- included
    // defensively since legacy UI libraries substitute them for the
    // documentElement.clientWidth idiom.
    function patchWindowMetrics() {
        if (typeof window === 'undefined') return 'absent';
        var names = ['innerWidth', 'innerHeight', 'scrollX', 'scrollY', 'pageXOffset', 'pageYOffset'];
        for (var i = 0; i < names.length; i++) {
            (function (name) {
                // Getters may be installed as own-properties or on the
                // Window prototype -- try both.
                var target = window;
                var desc = Object.getOwnPropertyDescriptor(window, name);
                if (!desc) {
                    var proto = Object.getPrototypeOf(window);
                    if (proto) {
                        desc = Object.getOwnPropertyDescriptor(proto, name);
                        if (desc) target = proto;
                    }
                }
                if (!desc || typeof desc.get !== 'function' || !desc.configurable) return;
                var originalGet = desc.get;
                var wm = measuredGet(originalGet, name);
                Object.defineProperty(target, name, {
                    get: wm,
                    set: desc.set,
                    enumerable: desc.enumerable,
                    configurable: true
                });
                patches.push(function () {
                    var cur = Object.getOwnPropertyDescriptor(target, name);
                    if (cur && cur.get === wm) Object.defineProperty(target, name, desc);
                });
            }(names[i]));
        }
        return true;
    }

    // --- Phase-lane scheduler wrappers (v1.3) ------------------------------
    //
    // Each wraps a scheduler so currentPhase reflects the callback the user's
    // code is running under. The restore is identity-checked (only unpatch our
    // own wrapper) and the phase push/pop is in a finally, so neither a foreign
    // shim installed on top nor a throwing callback can corrupt the state.

    // Wrap one callback so it runs under `phaseName`. Shared by every scheduler.
    function underPhase(cb, phaseName) {
        if (typeof cb !== 'function') return cb;
        return function () {
            pushPhase(phaseName);
            try {
                return cb.apply(this, arguments);
            } finally {
                popPhase();
            }
        };
    }

    // Assign the same wrapper to every host binding that currently holds the
    // original, so an unqualified `requestAnimationFrame(...)` (globalThis) and
    // a `window.requestAnimationFrame(...)` both route through it. In a real
    // browser window === globalThis and this is one assignment; under a test
    // stub or a worker they can differ. Restore is identity-checked per host.
    function patchGlobalFn(name, makeWrapper) {
        var hosts = [];
        if (typeof globalThis !== 'undefined') hosts.push(globalThis);
        if (typeof window !== 'undefined' && window !== globalThis) hosts.push(window);
        var original = null;
        for (var h = 0; h < hosts.length; h++) {
            if (typeof hosts[h][name] === 'function') { original = hosts[h][name]; break; }
        }
        if (original === null) return 'absent';
        var wrapped = makeWrapper(original);
        var touched = [];
        for (var j = 0; j < hosts.length; j++) {
            if (hosts[j][name] === original) {
                hosts[j][name] = wrapped;
                touched.push(hosts[j]);
            }
        }
        if (touched.length === 0) return 'absent';
        patches.push(function () {
            for (var t = 0; t < touched.length; t++) {
                if (touched[t][name] === wrapped) touched[t][name] = original;
            }
        });
        return true;
    }

    function patchRaf() {
        return patchGlobalFn('requestAnimationFrame', function (original) {
            return function (cb) {
                return original.call(this, underPhase(cb, 'raf'));
            };
        });
    }

    function patchTimers() {
        var a = patchGlobalFn('setTimeout', function (original) {
            return function (cb) {
                if (typeof cb !== 'function') return original.apply(this, arguments);
                var args = Array.prototype.slice.call(arguments);
                args[0] = underPhase(cb, 'timer');
                return original.apply(this, args);
            };
        });
        var b = patchGlobalFn('setInterval', function (original) {
            return function (cb) {
                if (typeof cb !== 'function') return original.apply(this, arguments);
                var args = Array.prototype.slice.call(arguments);
                args[0] = underPhase(cb, 'timer');
                return original.apply(this, args);
            };
        });
        return (a === true || b === true) ? true : 'absent';
    }

    function patchMicrotask() {
        var did = false;
        var qm = patchGlobalFn('queueMicrotask', function (original) {
            return function (cb) {
                return original.call(this, underPhase(cb, 'microtask'));
            };
        });
        if (qm === true) did = true;
        // Promise.prototype.then -- the other common microtask source.
        if (typeof Promise === 'function' && Promise.prototype &&
                typeof Promise.prototype.then === 'function') {
            var origThen = Promise.prototype.then;
            var wrappedThen = function (onF, onR) {
                return origThen.call(this, underPhase(onF, 'microtask'), underPhase(onR, 'microtask'));
            };
            Promise.prototype.then = wrappedThen;
            patches.push(function () {
                if (Promise.prototype.then === wrappedThen) Promise.prototype.then = origThen;
            });
            did = true;
        }
        return did ? true : 'absent';
    }

    function patchResizeObserver() {
        var hosts = [];
        if (typeof globalThis !== 'undefined') hosts.push(globalThis);
        if (typeof window !== 'undefined' && window !== globalThis) hosts.push(window);
        var OriginalRO = null;
        for (var h = 0; h < hosts.length; h++) {
            if (typeof hosts[h].ResizeObserver === 'function') { OriginalRO = hosts[h].ResizeObserver; break; }
        }
        if (OriginalRO === null) return 'absent';
        function WrappedRO(cb) {
            var wrappedCb = typeof cb === 'function'
                ? function () {
                    var prevIn = inRoCallback;
                    var prevWrote = roWroteThisCallback;
                    inRoCallback = true;
                    roWroteThisCallback = false;
                    pushPhase('ro-callback');
                    try {
                        return cb.apply(this, arguments);
                    } finally {
                        popPhase();
                        inRoCallback = prevIn;
                        roWroteThisCallback = prevWrote;
                    }
                }
                : cb;
            return new OriginalRO(wrappedCb);
        }
        WrappedRO.prototype = OriginalRO.prototype;
        var touched = [];
        for (var j = 0; j < hosts.length; j++) {
            if (hosts[j].ResizeObserver === OriginalRO) {
                hosts[j].ResizeObserver = WrappedRO;
                touched.push(hosts[j]);
            }
        }
        patches.push(function () {
            for (var t = 0; t < touched.length; t++) {
                if (touched[t].ResizeObserver === WrappedRO) touched[t].ResizeObserver = OriginalRO;
            }
        });
        return true;
    }

    // Patch every per-property setter on CSSStyleDeclaration.prototype so we
    // catch `el.style.width = 'X'` and similar direct assignments.
    //
    // Why this is essential: in real browsers (Chrome, Firefox) the WebIDL
    // per-property setters call into C++ internals directly, bypassing the
    // JS-level `setProperty` method on the prototype. Patching `setProperty`
    // alone therefore does not intercept `.style.width = X` -- the most
    // common style-write idiom. happy-dom happens to route through JS
    // setProperty, so the existing tests pass; the demo would silently
    // fail to flag violations in Chrome without this.
    //
    // We restore all patched properties in a single `patches` entry to
    // keep the closure count sane -- CSSStyleDeclaration.prototype has
    // ~400 property setters.
    function patchAllCssSetters() {
        if (typeof CSSStyleDeclaration === 'undefined') return 'absent';
        var proto = CSSStyleDeclaration.prototype;
        var names = Object.getOwnPropertyNames(proto);
        var restored = [];
        var candidates = 0;
        for (var i = 0; i < names.length; i++) {
            var name = names[i];
            // Skip: explicitly patched elsewhere, non-CSS accessors, or getter-only.
            if (name === 'setProperty' || name === 'removeProperty' || name === 'cssText') continue;
            var desc = Object.getOwnPropertyDescriptor(proto, name);
            if (!desc || typeof desc.set !== 'function' || typeof desc.get !== 'function') continue;
            candidates++;
            if (!desc.configurable) continue;
            (function (n, d) {
                var originalSet = d.set;
                var originalGet = d.get;
                var ws = function (v) {
                    markDirty('CSSStyleDeclaration.' + n + ' =');
                    return originalSet.call(this, v);
                };
                Object.defineProperty(proto, n, {
                    get: originalGet,
                    set: ws,
                    enumerable: d.enumerable,
                    configurable: true
                });
                restored.push({ name: n, desc: d, set: ws });
            }(name, desc));
        }
        patches.push(function () {
            for (var i = 0; i < restored.length; i++) {
                try {
                    var cur = Object.getOwnPropertyDescriptor(proto, restored[i].name);
                    if (cur && cur.set === restored[i].set) {
                        Object.defineProperty(proto, restored[i].name, restored[i].desc);
                    }
                } catch (e) { void e; }
            }
        });
        if (candidates === 0) return 'absent';
        return restored.length > 0;
    }

    // -- Apply all patches --

    // Every attempt below is guarded. A host that refuses one patch must not
    // take the whole profiler down with it -- but the refusal is counted, and
    // an incomplete net is reported to the gate as unverifiable rather than
    // being allowed to masquerade as a clean run.

    // 1. Write-side: mark dirty on DOM mutations.
    var writeTargets = buildWriteTargets();
    for (var wi = 0; wi < writeTargets.length; wi++) {
        (function (wt) {
            var srcName = (wt[0].constructor && wt[0].constructor.name) || 'DOM';
            attempt(srcName + '.' + wt[1], function () {
                return wt[2] === 'method'
                    ? patchMethod(wt[0], wt[1], srcName)
                    : patchSetter(wt[0], wt[1], srcName);
            });
        }(writeTargets[wi]));
    }

    // 2. Write-side: per-property setters on CSSStyleDeclaration.prototype.
    //    Catches `el.style.width = X` etc. in real browsers.
    attempt('CSSStyleDeclaration.<per-property setters>', patchAllCssSetters);

    // 3. Read-side: flag forced reflows on layout getters.
    var readProto = typeof HTMLElement !== 'undefined'
        ? HTMLElement.prototype : Element.prototype;
    for (var gi = 0; gi < ELEMENT_GETTERS.length; gi++) {
        (function (n) {
            attempt('read:' + n, function () { return patchGetter(readProto, n); });
        }(ELEMENT_GETTERS[gi]));
    }
    for (var si = 0; si < ELEMENT_GETSET.length; si++) {
        (function (n) {
            attempt('read:' + n, function () { return patchGetter(readProto, n); });
        }(ELEMENT_GETSET[si]));
    }
    attempt('read:getBoundingClientRect', patchBCR);
    attempt('read:getComputedStyle', patchGCS);
    attempt('read:svg', patchSvgReads);
    attempt('read:scrollMethods', patchScrollMethods);
    attempt('read:windowMetrics', patchWindowMetrics);

    // Phase lane wrappers (v1.3), only when opted in. Each sets currentPhase
    // for the duration of a scheduled callback, in a finally so a throwing
    // callback cannot strand the phase.
    //
    // rafObserved tracks whether the rAF wrapper SPECIFICALLY installed, which
    // is what maxInRaf actually depends on. `phases: true` is the intent, but
    // if requestAnimationFrame is absent from this host (a worker, an older
    // runtime) the rule is still unverifiable -- you cannot claim "no reflow in
    // rAF" on a host with no rAF. phasesObserved reports this truth, not intent.
    var rafObserved = false;
    if (trackPhases) {
        rafObserved = attempt('phase:raf', patchRaf) === true;
        attempt('phase:timers', patchTimers);
        attempt('phase:microtask', patchMicrotask);
        attempt('phase:resizeObserver', patchResizeObserver);
    }

    // -----------------------------------------------------------------------
    // Public surface
    // -----------------------------------------------------------------------

    function destroy() {
        active = false;
        // A host can be hardened after we patched it. Deactivation must still
        // complete, and every remaining restore must still be attempted.
        for (var i = patches.length - 1; i >= 0; i--) {
            try { patches[i](); } catch (e) { void e; }
        }
        patches.length = 0;
    }

    function reset() {
        // Clear only the slots actually holding records. Walking the whole
        // capacity would make reset cost what the ring could hold rather than
        // what it does hold, which is the wrong bill for a large cap.
        var start = ringCount < cap ? 0 : ringWrite;
        for (var i = 0; i < ringCount; i++) {
            var idx = start + i;
            if (idx >= cap) idx -= cap;
            ring[idx] = undefined;
        }
        ringWrite = 0;
        ringCount = 0;
        violationsCache = null;
        violationCount = 0;
    }

    // The summary is deliberately self-sufficient: it carries a lean snapshot
    // of the records rather than a live reference to the internal array, so
    // it can be JSON-serialised, shipped out of the browser, and gated in CI
    // by a process that never saw the profiler. That is the shape the v1.6
    // CLI gate consumes. Full stacks are omitted (they dominate the payload
    // and the gate matches on parsed sites); read profiler.violations for those.
    //
    // Not a hot path -- called once at gate time, allocates a snapshot.
    function summary() {
        var byRead = {};
        var byWrite = {};
        var byTask = {};
        var records = [];
        var costs = [];
        var totalMs = 0;
        var maxMs = 0;
        var unmeasured = 0;

        // Phase counts over the whole run (v1.3).
        var phaseCounts = {
            raf: 0, timer: 0, microtask: 0, roCallback: 0,
            event: 0, unknown: 0, unobserved: 0
        };
        // Thrash collapsing: fold identical (read, write, readSite, writeSite,
        // taskId) tuples into one group carrying a count. Keyed by that tuple;
        // the first occurrence is the canonical record. Done here, once, over
        // the retained ring -- never on the hot path.
        var thrashGroups = {};
        var thrashOrder = [];

        function phaseKey(p) {
            if (p === 'ro-callback') return 'roCallback';
            if (Object.prototype.hasOwnProperty.call(phaseCounts, p)) return p;
            return 'unknown';
        }

        forEachRecord(function (v) {
            byRead[v.read] = (byRead[v.read] || 0) + 1;
            byWrite[v.write] = (byWrite[v.write] || 0) + 1;
            byTask[v.taskId] = (byTask[v.taskId] || 0) + 1;
            phaseCounts[phaseKey(v.phase)]++;

            if (isMeasuredCost(v.costMs)) {
                costs.push(v.costMs);
                totalMs += v.costMs;
                if (v.costMs > maxMs) maxMs = v.costMs;
            } else {
                unmeasured++;
            }

            // summary.records stays the RAW one-record-per-reflow view, so the
            // gate's counting (maxReflows, maxPerTask, cost) remains exactly
            // correct -- collapsing here would make maxReflows count groups
            // instead of reflows. Thrash is a SEPARATE, additive view built
            // alongside, never a replacement.
            records.push({
                id: v.id,
                taskId: v.taskId,
                read: v.read,
                write: v.write,
                readSite: v.readSite,
                writeSite: v.writeSite,
                phase: v.phase,
                roFeedback: v.roFeedback,
                costMs: v.costMs,
                belowGranularity: v.belowGranularity,
                timestamp: v.timestamp
            });

            // Collapse key. taskId is part of it: a tuple recurring ACROSS
            // tasks is a per-frame pattern (maxPerTask's job), not a
            // within-block loop.
            var key = v.taskId + '\u0000' + v.read + '\u0000' + v.write +
                '\u0000' + v.readSite + '\u0000' + v.writeSite;
            var g = thrashGroups[key];
            if (g === undefined) {
                g = {
                    read: v.read,
                    write: v.write,
                    readSite: v.readSite,
                    writeSite: v.writeSite,
                    taskId: v.taskId,
                    phase: v.phase,
                    roFeedback: v.roFeedback,
                    count: 0,
                    costMs: null,
                    unmeasuredMembers: 0
                };
                thrashGroups[key] = g;
                thrashOrder.push(g);
            }
            g.count++;
            if (isMeasuredCost(v.costMs)) g.costMs = (g.costMs || 0) + v.costMs;
            else g.unmeasuredMembers++;
            if (v.roFeedback) g.roFeedback = true;
        });

        // Thrash list: collapsed groups with count > 1, worst first.
        var thrash = [];
        for (var gi = 0; gi < thrashOrder.length; gi++) {
            var grp = thrashOrder[gi];
            if (grp.count > 1) {
                thrash.push({
                    read: grp.read,
                    write: grp.write,
                    readSite: grp.readSite,
                    writeSite: grp.writeSite,
                    taskId: grp.taskId,
                    phase: grp.phase,
                    roFeedback: grp.roFeedback,
                    count: grp.count,
                    costMs: grp.costMs,
                    unmeasuredMembers: grp.unmeasuredMembers
                });
            }
        }
        thrash.sort(function (a, b) { return b.count - a.count; });

        // Worst collapsed count in any one task -- what maxThrash gates.
        var maxThrashCount = 0;
        for (var ti = 0; ti < thrash.length; ti++) {
            if (thrash[ti].count > maxThrashCount) maxThrashCount = thrash[ti].count;
        }

        // Percentiles over measured costs only. Sorting here is fine -- this
        // is called once at gate time, never inside a frame.
        var measured = costs.length;
        var p99 = null;
        if (measured > 0) {
            costs.sort(function (a, b) { return a - b; });
            var idx = Math.ceil(0.99 * measured) - 1;
            if (idx < 0) idx = 0;
            if (idx >= measured) idx = measured - 1;
            p99 = costs[idx];
        }

        return {
            total: violationCount,
            stored: ringCount,
            // What the patch net actually covers. `complete: false` means at
            // least one read or write went uninstrumented, so a zero here is
            // not evidence of anything.
            patched: {
                applied: patchApplied,
                failed: patchFailed,
                skipped: patchSkipped,
                complete: patchFailed === 0,
                failures: patchFailures.slice()
            },
            // Set once the storage cap has dropped records. Any gate rule that
            // needs per-record data refuses to evaluate against a torn set.
            truncated: violationCount > ringCount,
            // Whether call sites are real. `ignoreSites` is unverifiable without them.
            stacks: captureStacks,
            byRead: byRead,
            byWrite: byWrite,
            byTask: byTask,
            taskCount: Object.keys(byTask).length,
            // Phase lane (v1.3). Counts per scheduler over the whole run, and
            // whether the phase wrappers were installed at all. maxInRaf is
            // unverifiable when phasesObserved is false: you cannot assert
            // "no reflow in rAF" if rAF was never watched.
            phases: phaseCounts,
            phasesObserved: rafObserved,
            // Collapsed read-after-write loops (count > 1), worst first, plus
            // the worst single count for maxThrash to gate.
            thrash: thrash,
            maxThrashCount: maxThrashCount,
            // Every aggregate here is null rather than 0 when nothing was
            // measured. A zero would read as "no stall"; the truth is "no
            // number". resolutionMs null means the clock floor is unknown,
            // so no cost could be claimed at all.
            cost: {
                resolutionMs: resolutionMs,
                measured: measured,
                unmeasured: unmeasured,
                totalMs: measured > 0 ? totalMs : null,
                maxMs: measured > 0 ? maxMs : null,
                avgMs: measured > 0 ? totalMs / measured : null,
                p99Ms: p99
            },
            records: records
        };
    }

    return {
        // Chronological snapshot of the ring, cached until the next capture.
        // v1.1 returned the live internal array; this returns a stable copy,
        // so holding a reference across further reflows no longer mutates
        // under you.
        get violations() {
            if (violationsCache === null) {
                var out = [];
                forEachRecord(function (v) { out.push(v); });
                violationsCache = out;
            }
            return violationsCache;
        },
        get violationCount() { return violationCount; },
        get active() { return active; },
        destroy: destroy,
        reset: reset,
        summary: summary
    };
}
