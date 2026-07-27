// Shared harness for torture tests.
//
// Two halves. The axis assertions make the intent of each scenario visible at
// the call site, so a file reads as a flat list of claims rather than a pile
// of asserts. The DOM factory builds hostile hosts: frozen prototypes,
// non-configurable descriptors, accessors that throw, foreign patches already
// in place. The production stub used by 03/05 is the friendly case; this one
// exists to be unfriendly.
//
// This file is not named *.test.mjs, so the runner does not execute it.

import assert from 'node:assert/strict';
import {
    checkNoReflow, assertNoReflow, ReflowBudgetError
} from '../../LayoutProfiler.js';

// ---------------------------------------------------------------------------
// Axis assertions
// ---------------------------------------------------------------------------

/**
 * Axis A -- adversarial input that MUST come back unverified.
 *
 * Never `ok`. A green verdict here is the worst bug this package can have:
 * the gate claimed to have checked something it could not see. Ranks above
 * every other correctness concern in this suite.
 */
export function assertAxisA(summary, rules, label) {
    const rep = checkNoReflow(summary, rules);
    if (rep.ok === true) {
        assert.fail('AXIS A VIOLATION [' + label + ']: ok=true on adversarial input. ' +
            'A silent pass means the gate lied about what it verified.');
    }
    assert.equal(rep.verified, false,
        'AXIS A VIOLATION [' + label + ']: expected verified=false, got true. ' +
        'The gate treated unverifiable evidence as a real breach.');
    assert.ok(rep.violations.some((v) => v.limit === null),
        label + ': an unverifiable run must carry at least one limit:null violation');
    assert.throws(() => assertNoReflow(summary, rules), ReflowBudgetError,
        label + ': assertNoReflow must throw on axis-A input');
    return rep;
}

/** Axis B -- real signal buried in noise. MUST fail, and MUST be verified. */
export function assertAxisB(summary, rules, label) {
    const rep = checkNoReflow(summary, rules);
    assert.equal(rep.ok, false, label + ': expected a breach, got ok=true');
    assert.equal(rep.verified, true,
        label + ': expected a verified breach, got unverified -- the gate ' +
        'dodged the question instead of answering it');
    assert.ok(rep.violations.length > 0, label + ': a breach must name a rule');
    assert.throws(() => assertNoReflow(summary, rules), ReflowBudgetError, label);
    return rep;
}

/** Axis C -- clean signal under hostile conditions. MUST pass. */
export function assertAxisC(summary, rules, label) {
    const rep = checkNoReflow(summary, rules);
    assert.equal(rep.ok, true, label + ': expected pass, got violations ' +
        JSON.stringify(rep.violations));
    assert.equal(rep.verified, true, label + ': pass must be a verified pass');
    assert.equal(rep.violations.length, 0, label + ': a pass has no violations');
    assert.doesNotThrow(() => assertNoReflow(summary, rules), label);
    return rep;
}

/** Axis D -- a self-consistency invariant across the API surface. */
export function assertAxisD(predicate, label) {
    const r = predicate();
    assert.ok(r === true || r === undefined,
        'AXIS D VIOLATION [' + label + ']: invariant returned ' + r);
}

// ---------------------------------------------------------------------------
// Summary and record builders
// ---------------------------------------------------------------------------

let seq = 0;

export function makeRecord(over) {
    seq++;
    return Object.assign({
        id: seq,
        taskId: 0,
        read: 'offsetWidth',
        write: 'CSSStyleDeclaration.width =',
        readSite: '  at updateSize (app.js:42:12)',
        writeSite: '  at resizeHandler (app.js:38:5)',
        costMs: 1,
        belowGranularity: false,
        // v1.3 phase-lane fields. Default 'unobserved' so pre-phase tests
        // (which never set phase) describe a run recorded with phases off.
        phase: 'unobserved',
        roFeedback: false,
        timestamp: 0
    }, over);
}

/** A summary literal in the shape production summary() emits. */
export function makeSummary(records, over) {
    const list = records || [];
    const byRead = {}, byWrite = {}, byTask = {};
    const costs = [];
    let unmeasured = 0;
    const phases = { raf: 0, timer: 0, microtask: 0, roCallback: 0, event: 0, unknown: 0, unobserved: 0 };
    const groups = new Map();
    for (const r of list) {
        if (r === null || typeof r !== 'object') continue;
        byRead[r.read] = (byRead[r.read] || 0) + 1;
        byWrite[r.write] = (byWrite[r.write] || 0) + 1;
        byTask[r.taskId] = (byTask[r.taskId] || 0) + 1;
        if (typeof r.costMs === 'number' && isFinite(r.costMs) && r.costMs >= 0) {
            costs.push(r.costMs);
        } else {
            unmeasured++;
        }
        const pk = r.phase === 'ro-callback' ? 'roCallback'
            : (Object.prototype.hasOwnProperty.call(phases, r.phase) ? r.phase : 'unknown');
        phases[pk]++;
        const key = r.taskId + '\u0000' + r.read + '\u0000' + r.write +
            '\u0000' + r.readSite + '\u0000' + r.writeSite;
        const g = groups.get(key) || { count: 0, read: r.read, write: r.write,
            readSite: r.readSite, writeSite: r.writeSite, taskId: r.taskId, phase: r.phase };
        g.count++;
        groups.set(key, g);
    }
    const measured = costs.length;
    const total = costs.reduce((a, b) => a + b, 0);
    const thrash = [];
    for (const g of groups.values()) if (g.count > 1) thrash.push(g);
    thrash.sort((a, b) => b.count - a.count);
    const maxThrashCount = thrash.length > 0 ? thrash[0].count : 0;
    return Object.assign({
        total: list.length,
        stored: list.length,
        truncated: false,
        stacks: true,
        byRead, byWrite, byTask,
        taskCount: Object.keys(byTask).length,
        // v1.3 fields. phasesObserved defaults false (records default to
        // 'unobserved'); a scenario testing maxInRaf sets it true explicitly.
        phases,
        phasesObserved: false,
        thrash,
        maxThrashCount,
        cost: {
            resolutionMs: 0.1,
            measured,
            unmeasured,
            totalMs: measured > 0 ? total : null,
            maxMs: measured > 0 ? Math.max.apply(null, costs) : null,
            avgMs: measured > 0 ? total / measured : null,
            p99Ms: measured > 0 ? Math.max.apply(null, costs) : null
        },
        records: list
    }, over);
}

// ---------------------------------------------------------------------------
// Hostile DOM factory
// ---------------------------------------------------------------------------

/**
 * Install a stub DOM into globalThis.
 *
 * Options let a scenario break the host in one specific way, so a failure
 * points at one cause:
 *
 *   freeze          array of prototype names to Object.freeze
 *   nonConfigurable array of 'Proto.prop' to define as configurable:false
 *   throwOnRead     read getters throw instead of returning
 *   throwOnWrite    style setters throw instead of storing
 *   omit            array of globals to leave undefined
 *   foreignPatch    wrap offsetWidth in a foreign accessor before we patch
 *   readCost        ms the injected clock advances inside a layout read
 */
export function installDom(options) {
    const o = options || {};
    const omit = o.omit || [];
    const frozen = o.freeze || [];
    const nonConf = o.nonConfigurable || [];
    const state = { advance: function () {}, readCost: o.readCost || 0, foreignReads: 0 };

    function has(name) { return omit.indexOf(name) < 0; }
    function isNonConf(key) { return nonConf.indexOf(key) >= 0; }

    function Node() {}
    Node.prototype.appendChild = function (c) { return c; };
    Node.prototype.removeChild = function (c) { return c; };
    Object.defineProperty(Node.prototype, 'textContent', {
        get() { return this._t || ''; },
        set(v) { this._t = v; },
        configurable: !isNonConf('Node.textContent')
    });

    function Element() {}
    Element.prototype = Object.create(Node.prototype);
    Element.prototype.constructor = Element;
    Element.prototype.setAttribute = function () {
        if (o.throwOnWrite) throw new Error('hostile setAttribute');
    };
    Element.prototype.removeAttribute = function () {};
    Element.prototype.toggleAttribute = function () {};
    Element.prototype.getBoundingClientRect = function () {
        if (o.throwOnRead) throw new Error('hostile getBoundingClientRect');
        state.advance(state.readCost);
        return { x: 0, y: 0, width: 0, height: 0 };
    };
    Element.prototype.scrollIntoView = function () { state.advance(state.readCost); };
    Object.defineProperty(Element.prototype, 'className', {
        get() { return this._c || ''; },
        set(v) {
            if (o.throwOnWrite) throw new Error('hostile className');
            this._c = v;
        },
        configurable: !isNonConf('Element.className')
    });
    Object.defineProperty(Element.prototype, 'innerHTML', {
        get() { return this._h || ''; }, set(v) { this._h = v; }, configurable: true
    });

    function CSSStyleDeclaration() { this._p = {}; }
    CSSStyleDeclaration.prototype.setProperty = function (k, v) { this._p[k] = v; };
    CSSStyleDeclaration.prototype.removeProperty = function (k) { delete this._p[k]; };
    Object.defineProperty(CSSStyleDeclaration.prototype, 'cssText', {
        get() { return this._x || ''; }, set(v) { this._x = v; }, configurable: true
    });
    for (const prop of ['width', 'height', 'top', 'left', 'transform']) {
        Object.defineProperty(CSSStyleDeclaration.prototype, prop, {
            get() { return this._p[prop] || ''; },
            set(v) {
                if (o.throwOnWrite) throw new Error('hostile style.' + prop);
                this._p[prop] = v;
            },
            configurable: !isNonConf('CSSStyleDeclaration.' + prop),
            enumerable: true
        });
    }

    function HTMLElement() {}
    HTMLElement.prototype = Object.create(Element.prototype);
    HTMLElement.prototype.constructor = HTMLElement;
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
        get() { return this._i || ''; }, set(v) { this._i = v; }, configurable: true
    });
    const metrics = [
        'offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft',
        'clientWidth', 'clientHeight', 'clientTop', 'clientLeft',
        'scrollWidth', 'scrollHeight', 'scrollTop', 'scrollLeft'
    ];
    for (const m of metrics) {
        Object.defineProperty(HTMLElement.prototype, m, {
            get() {
                if (o.throwOnRead) throw new Error('hostile ' + m);
                state.advance(state.readCost);
                return 100;
            },
            set() {},
            configurable: !isNonConf('HTMLElement.' + m)
        });
    }

    // A foreign instrumenter that patched the prototype before we did.
    if (o.foreignPatch) {
        const d = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
        const inner = d.get;
        Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
            get() { state.foreignReads++; return inner.call(this); },
            set: d.set,
            configurable: true
        });
    }

    const win = {
        getComputedStyle() { return new CSSStyleDeclaration(); },
        scrollTo() {}, scrollBy() {}, scroll() {}
    };
    for (const m of ['innerWidth', 'innerHeight', 'scrollX', 'scrollY']) {
        Object.defineProperty(win, m, { get() { return 0; }, configurable: true });
    }

    if (frozen.indexOf('Node') >= 0) Object.freeze(Node.prototype);
    if (frozen.indexOf('Element') >= 0) Object.freeze(Element.prototype);
    if (frozen.indexOf('HTMLElement') >= 0) Object.freeze(HTMLElement.prototype);
    if (frozen.indexOf('CSSStyleDeclaration') >= 0) Object.freeze(CSSStyleDeclaration.prototype);

    if (has('Node')) globalThis.Node = Node;
    if (has('Element')) globalThis.Element = Element;
    if (has('HTMLElement')) globalThis.HTMLElement = HTMLElement;
    if (has('CSSStyleDeclaration')) globalThis.CSSStyleDeclaration = CSSStyleDeclaration;
    if (has('window')) globalThis.window = win;

    state.make = function () {
        const el = new HTMLElement();
        el.style = new CSSStyleDeclaration();
        return el;
    };
    state.protos = { Node, Element, HTMLElement, CSSStyleDeclaration };
    state.window = win;
    return state;
}

export function removeDom() {
    delete globalThis.Node;
    delete globalThis.Element;
    delete globalThis.HTMLElement;
    delete globalThis.CSSStyleDeclaration;
    delete globalThis.window;
}

/**
 * Snapshot every own property descriptor of the prototypes we patch, so a
 * teardown can be proved exact rather than merely plausible.
 */
export function snapshotProtos(protos) {
    const snap = {};
    for (const key of Object.keys(protos)) {
        const proto = protos[key].prototype;
        const names = Object.getOwnPropertyNames(proto);
        const entry = {};
        for (const n of names) entry[n] = Object.getOwnPropertyDescriptor(proto, n);
        snap[key] = entry;
    }
    return snap;
}

/** Compare a later snapshot against an earlier one, descriptor by descriptor. */
export function diffProtos(before, after) {
    const drift = [];
    for (const key of Object.keys(before)) {
        const b = before[key];
        const a = after[key] || {};
        for (const n of Object.keys(b)) {
            if (!(n in a)) { drift.push(key + '.' + n + ': vanished'); continue; }
            const x = b[n], y = a[n];
            if (x.get !== y.get) drift.push(key + '.' + n + ': getter identity changed');
            if (x.set !== y.set) drift.push(key + '.' + n + ': setter identity changed');
            if (x.value !== y.value) drift.push(key + '.' + n + ': value identity changed');
            if (x.configurable !== y.configurable) drift.push(key + '.' + n + ': configurable changed');
            if (x.enumerable !== y.enumerable) drift.push(key + '.' + n + ': enumerable changed');
        }
        for (const n of Object.keys(a)) {
            if (!(n in b)) drift.push(key + '.' + n + ': appeared');
        }
    }
    return drift;
}

/** A clock whose behaviour can be made pathological. */
export function makeClock(kind, tick) {
    let t = 1000;
    const step = tick === undefined ? 0.05 : tick;
    switch (kind) {
        case 'frozen': return () => 5000;
        case 'backwards': return () => { t -= step; return t; };
        case 'nan': return () => NaN;
        case 'infinite': return () => Infinity;
        case 'string': return () => String(t += step);
        case 'throwing': return () => { throw new Error('hostile clock'); };
        case 'jitter': {
            let n = 0;
            return () => { n++; t += (n % 3 === 0) ? step * 10 : step; return t; };
        }
        default: {
            const fn = () => { t += step; return t; };
            fn.jump = (ms) => { t += ms; };
            return fn;
        }
    }
}
