// @zakkster/lite-layout-profiler 1.1.0
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
// NOT zero-GC. This is a diagnostic tool that allocates per violation.
// Ship behind a __DEV__ flag or strip from production builds.
//
// Copyright (c) 2026 Zahary Shinikchiev <shinikchiev@yahoo.com>
// MIT License

export const VERSION = '1.1.0';

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
        if (line.length > 0) return line;
    }
    return lines[2] ? lines[2].trim() : '(unknown)';
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
    'maxReflows', 'maxPerTask', 'allowReads', 'allowWrites', 'ignoreSites'
];

// Rules that belong to lanes not yet shipped. Recognised so the error can say
// what is actually wrong instead of offering a nonsense spelling suggestion.
const FUTURE_RULE_KEYS = {
    maxCostMs: ['1.2', 'cost lane'],
    maxTotalCostMs: ['1.2', 'cost lane'],
    maxInRaf: ['1.3', 'phase lane'],
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
        violations: []
    };

    var hasAllowlist =
        allowReads.length > 0 || allowWrites.length > 0 || ignoreSites.length > 0;
    var needsRecords = hasAllowlist || maxPerTask !== Infinity;
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
                    byRead: {}, byWrite: {}, byTask: {},
                    taskCount: 0, records: []
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
    var warnToConsole = opts.warnToConsole !== false;
    var ignorePatterns = opts.ignorePatterns || [];

    var violations = [];
    var violationCount = 0;
    var active = true;

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

    function onRead(prop) {
        if (!active || dirty === null) return;
        var readStack = captureStacks ? captureStack() : '';
        if (shouldIgnore(readStack)) return;

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
            timestamp: typeof performance !== 'undefined' ? performance.now() : Date.now()
        };

        if (violations.length >= maxViolations) violations.shift();
        violations.push(v);

        if (onViolation !== null) onViolation(v);
        if (warnToConsole) {
            console.warn(
                '[lite-layout-profiler] Forced reflow #' + violationCount +
                ': read `' + prop + '` after `' + dirtySource + '`' +
                '\n  read at:  ' + v.readSite +
                '\n  write at: ' + v.writeSite
            );
        }

        // After the forced reflow, layout IS recalculated. Subsequent
        // reads (without intervening writes) are cheap. Clear dirty so
        // we don't flag the same reflow multiple times.
        dirty = null;
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
            get: function () {
                onRead(name);
                return originalGet.call(this);
            },
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
        Element.prototype.getBoundingClientRect = function () {
            onRead('getBoundingClientRect()');
            return original.call(this);
        };
        patches.push(function () {
            Element.prototype.getBoundingClientRect = original;
        });
    }

    // Patch getComputedStyle.
    function patchGCS() {
        if (typeof window === 'undefined') return;
        var original = window.getComputedStyle;
        if (!original) return;
        window.getComputedStyle = function () {
            onRead('getComputedStyle()');
            return original.apply(window, arguments);
        };
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
                proto[name] = function () {
                    onRead(name + '()');
                    return original.apply(this, arguments);
                };
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
                obj[name] = function () {
                    onRead(name + '()');
                    return original.apply(this, arguments);
                };
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
                    get: function () {
                        onRead(name);
                        return originalGet.call(this);
                    },
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
        violations.length = 0;
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
        for (var i = 0; i < violations.length; i++) {
            var v = violations[i];
            byRead[v.read] = (byRead[v.read] || 0) + 1;
            byWrite[v.write] = (byWrite[v.write] || 0) + 1;
            byTask[v.taskId] = (byTask[v.taskId] || 0) + 1;
            records.push({
                id: v.id,
                taskId: v.taskId,
                read: v.read,
                write: v.write,
                readSite: v.readSite,
                writeSite: v.writeSite,
                timestamp: v.timestamp
            });
        }
        return {
            total: violationCount,
            stored: violations.length,
            // Set once the storage cap has dropped records. Any gate rule that
            // needs per-record data refuses to evaluate against a torn set.
            truncated: violationCount > violations.length,
            // Whether call sites are real. `ignoreSites` is unverifiable without them.
            stacks: captureStacks,
            byRead: byRead,
            byWrite: byWrite,
            byTask: byTask,
            taskCount: Object.keys(byTask).length,
            records: records
        };
    }

    return {
        get violations() { return violations; },
        get violationCount() { return violationCount; },
        get active() { return active; },
        destroy: destroy,
        reset: reset,
        summary: summary
    };
}
