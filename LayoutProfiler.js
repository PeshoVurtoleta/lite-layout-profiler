// @zakkster/lite-layout-profiler 1.0.0
// Dev-mode forced-reflow detector. Patches layout-triggering getters on
// Element/HTMLElement prototypes, tracks DOM writes that invalidate layout,
// and flags read-after-write within the same synchronous task. Attributes
// each violation to a call site via Error.stack.
//
// NOT zero-GC. This is a diagnostic tool that allocates per violation.
// Ship behind a __DEV__ flag or strip from production builds.
//
// Copyright (c) 2026 Zahary Shinikchiev <shinikchiev@yahoo.com>
// MIT License

export const VERSION = '1.0.0';

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
        // Non-browser environment: return a no-op profiler.
        return {
            violations: [], violationCount: 0,
            destroy: function () {}, reset: function () {},
            get active() { return false; }
        };
    }

    var opts = options || {};
    var maxViolations = opts.maxViolations || 200;
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

    function summary() {
        var byRead = {};
        var byWrite = {};
        for (var i = 0; i < violations.length; i++) {
            var v = violations[i];
            byRead[v.read] = (byRead[v.read] || 0) + 1;
            byWrite[v.write] = (byWrite[v.write] || 0) + 1;
        }
        return {
            total: violationCount,
            stored: violations.length,
            byRead: byRead,
            byWrite: byWrite
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
