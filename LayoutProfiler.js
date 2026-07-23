// @zakkster/lite-layout-profiler 1.2.0
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
// NOT zero-GC. This is a diagnostic tool that allocates per violation.
// Ship behind a __DEV__ flag or strip from production builds.
//
// Copyright (c) 2026 Zahary Shinikchiev <shinikchiev@yahoo.com>
// MIT License

export const VERSION = '1.2.0';

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
    'allowReads', 'allowWrites', 'ignoreSites'
];

// Rules that belong to lanes not yet shipped. Recognised so the error can say
// what is actually wrong instead of offering a nonsense spelling suggestion.
const FUTURE_RULE_KEYS = {
    maxInRaf: ['1.3', 'phase lane'],
    maxThrash: ['1.3', 'phase lane'],
    allowExpected: ['1.5', 'expected-scope lane']
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
    var r = rules || {};
    validateRules(r);

    var maxReflows = r.maxReflows === undefined ? 0 : r.maxReflows;
    var maxPerTask = r.maxPerTask === undefined ? Infinity : r.maxPerTask;
    var maxCostMs = r.maxCostMs === undefined ? Infinity : r.maxCostMs;
    var maxTotalCostMs = r.maxTotalCostMs === undefined ? Infinity : r.maxTotalCostMs;
    var allowReads = r.allowReads || [];
    var allowWrites = r.allowWrites || [];
    var ignoreSites = r.ignoreSites || [];

    var total = typeof summary.total === 'number' ? summary.total : 0;

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

    var needsCost = maxCostMs !== Infinity || maxTotalCostMs !== Infinity;
    var hasAllowlist =
        allowReads.length > 0 || allowWrites.length > 0 || ignoreSites.length > 0;
    var needsRecords = hasAllowlist || maxPerTask !== Infinity || needsCost;
    var records = Array.isArray(summary.records) ? summary.records : null;

    // -- Evidence checks, before any counting --

    if (needsRecords && records === null) {
        unverifiable(out, 'records', 'absent',
            'Rules requiring per-record data were set, but the summary ' +
            'carries no `records` array (summary from a pre-1.1 build?).');
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
            if (typeof cost !== 'number') { unmeasured++; continue; }
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

/**
 * @param {object} [options]
 * @param {number} [options.maxViolations=200]
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
                    byRead: {}, byWrite: {}, byTask: {}, taskCount: 0,
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
    var maxViolations = opts.maxStored || opts.maxViolations || 200;
    var onViolation = opts.onViolation || null;
    var captureStacks = opts.captureStacks !== false;
    var measureCost = opts.measureCost !== false;
    // Monotonic millisecond clock. Defaults to performance.now(). Overridable
    // for environments without it, and so tests can drive a clock with known
    // granularity instead of hoping the host's happens to be coarse.
    var clk = typeof opts.clock === 'function' ? opts.clock : clock;
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
        if (resolutionMs !== null) {
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
            timestamp: clk()
        };

        pushRecord(v);

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

        // After the forced reflow, layout IS recalculated. Subsequent
        // reads (without intervening writes) are cheap. Clear dirty so
        // we don't flag the same reflow multiple times.
        dirty = null;
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

    // Patch a method: wrap it to call markDirty before the original.
    function patchMethod(proto, name, source) {
        var original = proto[name];
        if (typeof original !== 'function') return;
        proto[name] = function () {
            markDirty(source + '.' + name + '()');
            return original.apply(this, arguments);
        };
        patches.push(function () { proto[name] = original; });
    }

    // Patch a setter: wrap set to call markDirty, keep get unchanged.
    function patchSetter(proto, name, source) {
        var desc = Object.getOwnPropertyDescriptor(proto, name);
        if (!desc || !desc.set) return;
        var originalSet = desc.set;
        var originalGet = desc.get;
        Object.defineProperty(proto, name, {
            get: originalGet,
            set: function (v) {
                markDirty(source + '.' + name + ' =');
                return originalSet.call(this, v);
            },
            enumerable: desc.enumerable,
            configurable: true
        });
        patches.push(function () {
            Object.defineProperty(proto, name, desc);
        });
    }

    // Patch a getter to call onRead when dirty.
    function patchGetter(proto, name) {
        var desc = Object.getOwnPropertyDescriptor(proto, name);
        if (!desc || !desc.get) return;
        var originalGet = desc.get;
        var originalSet = desc.set;
        var newDesc = {
            get: measuredGet(originalGet, name),
            enumerable: desc.enumerable,
            configurable: true
        };
        if (originalSet) newDesc.set = originalSet;
        Object.defineProperty(proto, name, newDesc);
        patches.push(function () {
            Object.defineProperty(proto, name, desc);
        });
    }

    // Patch getBoundingClientRect.
    function patchBCR() {
        var original = Element.prototype.getBoundingClientRect;
        Element.prototype.getBoundingClientRect =
            measuredCall(original, 'getBoundingClientRect()');
        patches.push(function () {
            Element.prototype.getBoundingClientRect = original;
        });
    }

    // Patch getComputedStyle.
    function patchGCS() {
        if (typeof window === 'undefined') return;
        var original = window.getComputedStyle;
        if (!original) return;
        window.getComputedStyle = measuredCall(original, 'getComputedStyle()', window);
        patches.push(function () { window.getComputedStyle = original; });
    }

    // Patch SVG layout-triggering reads. Anything measured against the SVG
    // coordinate space forces layout the same way getBoundingClientRect does.
    // Essential for reactive charting / dataviz code that reads geometry to
    // position tooltips or hit-test paths.
    function patchSvgReads() {
        if (typeof SVGGraphicsElement === 'undefined') return;
        var proto = SVGGraphicsElement.prototype;
        var names = ['getBBox', 'getCTM', 'getScreenCTM'];
        for (var i = 0; i < names.length; i++) {
            (function (name) {
                var original = proto[name];
                if (typeof original !== 'function') return;
                proto[name] = measuredCall(original, name + '()');
                patches.push(function () { proto[name] = original; });
            }(names[i]));
        }
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
                obj[name] = measuredCall(original, name + '()');
                patches.push(function () { obj[name] = original; });
            }(targets[i][0], targets[i][1]));
        }
    }

    // Patch window-level metric getters. scrollY / scrollX / pageOffset can
    // force reflow after DOM writes (browser must know current scroll extent);
    // innerWidth / innerHeight may or may not depending on browser -- included
    // defensively since legacy UI libraries substitute them for the
    // documentElement.clientWidth idiom.
    function patchWindowMetrics() {
        if (typeof window === 'undefined') return;
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
                Object.defineProperty(target, name, {
                    get: measuredGet(originalGet, name),
                    set: desc.set,
                    enumerable: desc.enumerable,
                    configurable: true
                });
                patches.push(function () {
                    Object.defineProperty(target, name, desc);
                });
            }(names[i]));
        }
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
        if (typeof CSSStyleDeclaration === 'undefined') return;
        var proto = CSSStyleDeclaration.prototype;
        var names = Object.getOwnPropertyNames(proto);
        var restored = [];
        for (var i = 0; i < names.length; i++) {
            var name = names[i];
            // Skip: explicitly patched elsewhere, non-CSS accessors, or getter-only.
            if (name === 'setProperty' || name === 'removeProperty' || name === 'cssText') continue;
            var desc = Object.getOwnPropertyDescriptor(proto, name);
            if (!desc || typeof desc.set !== 'function' || typeof desc.get !== 'function') continue;

            (function (n, d) {
                var originalSet = d.set;
                var originalGet = d.get;
                Object.defineProperty(proto, n, {
                    get: originalGet,
                    set: function (v) {
                        markDirty('CSSStyleDeclaration.' + n + ' =');
                        return originalSet.call(this, v);
                    },
                    enumerable: d.enumerable,
                    configurable: true
                });
                restored.push({ name: n, desc: d });
            }(name, desc));
        }
        patches.push(function () {
            for (var i = 0; i < restored.length; i++) {
                Object.defineProperty(proto, restored[i].name, restored[i].desc);
            }
        });
    }

    // -- Apply all patches --

    // 1. Write-side: mark dirty on DOM mutations.
    var writeTargets = buildWriteTargets();
    for (var wi = 0; wi < writeTargets.length; wi++) {
        var wt = writeTargets[wi];
        var srcName = (wt[0].constructor && wt[0].constructor.name) || 'DOM';
        if (wt[2] === 'method') patchMethod(wt[0], wt[1], srcName);
        else if (wt[2] === 'setter') patchSetter(wt[0], wt[1], srcName);
    }

    // 2. Write-side: per-property setters on CSSStyleDeclaration.prototype.
    //    Catches `el.style.width = X` etc. in real browsers.
    patchAllCssSetters();

    // 3. Read-side: flag forced reflows on layout getters.
    var readProto = typeof HTMLElement !== 'undefined'
        ? HTMLElement.prototype : Element.prototype;
    for (var gi = 0; gi < ELEMENT_GETTERS.length; gi++) {
        patchGetter(readProto, ELEMENT_GETTERS[gi]);
    }
    for (var si = 0; si < ELEMENT_GETSET.length; si++) {
        patchGetter(readProto, ELEMENT_GETSET[si]);
    }
    patchBCR();
    patchGCS();
    patchSvgReads();       // SVGGraphicsElement.getBBox / getCTM / getScreenCTM
    patchScrollMethods();  // scrollIntoView / scrollTo / scrollBy (Element + window)
    patchWindowMetrics();  // window.innerWidth / innerHeight / scrollX / scrollY / ...

    // -----------------------------------------------------------------------
    // Public surface
    // -----------------------------------------------------------------------

    function destroy() {
        active = false;
        for (var i = patches.length - 1; i >= 0; i--) patches[i]();
        patches.length = 0;
    }

    function reset() {
        for (var i = 0; i < cap; i++) ring[i] = undefined;
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

        forEachRecord(function (v) {
            byRead[v.read] = (byRead[v.read] || 0) + 1;
            byWrite[v.write] = (byWrite[v.write] || 0) + 1;
            byTask[v.taskId] = (byTask[v.taskId] || 0) + 1;
            if (typeof v.costMs === 'number') {
                costs.push(v.costMs);
                totalMs += v.costMs;
                if (v.costMs > maxMs) maxMs = v.costMs;
            } else {
                unmeasured++;
            }
            records.push({
                id: v.id,
                taskId: v.taskId,
                read: v.read,
                write: v.write,
                readSite: v.readSite,
                writeSite: v.writeSite,
                costMs: v.costMs,
                belowGranularity: v.belowGranularity,
                timestamp: v.timestamp
            });
        });

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
            // Set once the storage cap has dropped records. Any gate rule that
            // needs per-record data refuses to evaluate against a torn set.
            truncated: violationCount > ringCount,
            // Whether call sites are real. `ignoreSites` is unverifiable without them.
            stacks: captureStacks,
            byRead: byRead,
            byWrite: byWrite,
            byTask: byTask,
            taskCount: Object.keys(byTask).length,
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
