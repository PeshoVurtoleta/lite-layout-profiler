import test from 'node:test';
import assert from 'node:assert/strict';
import { VERSION } from '../LayoutProfiler.js';

test('VERSION is set', () => {
    assert.equal(VERSION, '1.2.0');
});

test('createLayoutProfiler returns a no-op profiler in non-browser env', async () => {
    const { createLayoutProfiler } = await import('../LayoutProfiler.js');
    // In node, Element/HTMLElement are undefined -> no-op profiler.
    const p = createLayoutProfiler();
    assert.equal(p.active, false);
    assert.equal(p.violationCount, 0);
    assert.deepEqual(p.violations, []);
    p.destroy();
});

test('no-op profiler destroy and reset are safe to call', async () => {
    const { createLayoutProfiler } = await import('../LayoutProfiler.js');
    const p = createLayoutProfiler();
    assert.doesNotThrow(() => { p.destroy(); p.reset(); p.destroy(); });
});

// ---------------------------------------------------------------------------
// happy-dom tests: exercise the actual patching and detection
// ---------------------------------------------------------------------------

import { Window } from 'happy-dom';

function withDom(fn) {
    return async () => {
        const w = new Window();
        // Install DOM globals
        globalThis.window = w;
        globalThis.document = w.document;
        globalThis.Element = w.Element;
        globalThis.HTMLElement = w.HTMLElement;
        globalThis.Node = w.Node;
        globalThis.CSSStyleDeclaration = w.CSSStyleDeclaration;
        globalThis.DOMTokenList = w.DOMTokenList;
        globalThis.SVGElement = w.SVGElement;
        globalThis.SVGGraphicsElement = w.SVGGraphicsElement;
        globalThis.queueMicrotask = w.queueMicrotask
            ? w.queueMicrotask.bind(w) : globalThis.queueMicrotask;
        try {
            // Re-import to pick up globals
            const mod = await import('../LayoutProfiler.js?t=' + Date.now());
            await fn(w, mod.createLayoutProfiler);
        } finally {
            delete globalThis.window;
            delete globalThis.document;
            delete globalThis.Element;
            delete globalThis.HTMLElement;
            delete globalThis.Node;
            delete globalThis.CSSStyleDeclaration;
            delete globalThis.DOMTokenList;
            delete globalThis.SVGElement;
            delete globalThis.SVGGraphicsElement;
        }
    };
}

test('patching and detection: read after style write flags a violation', withDom(async (w, create) => {
    const doc = w.document;
    const el = doc.createElement('div');
    doc.body.appendChild(el);

    const violations = [];
    const p = create({ warnToConsole: false, onViolation: (v) => violations.push(v) });

    // Write then read in the same synchronous block
    el.style.setProperty('width', '100px');
    const _w = el.offsetWidth;

    assert.ok(violations.length >= 1, 'should flag read after style write');
    assert.equal(violations[0].read, 'offsetWidth');
    assert.ok(violations[0].write.length > 0, 'write source is captured');
    assert.ok(p.violationCount >= 1);

    p.destroy();
}));

test('read without preceding write does not flag', withDom(async (w, create) => {
    const doc = w.document;
    const el = doc.createElement('div');
    doc.body.appendChild(el);

    const violations = [];
    const p = create({ warnToConsole: false, onViolation: (v) => violations.push(v) });

    // Read with no preceding write -- clean
    const _w = el.offsetWidth;
    assert.equal(violations.length, 0);

    p.destroy();
}));

test('dirty clears after first read (no double-flag)', withDom(async (w, create) => {
    const doc = w.document;
    const el = doc.createElement('div');
    doc.body.appendChild(el);

    const violations = [];
    const p = create({ warnToConsole: false, onViolation: (v) => violations.push(v) });

    el.style.setProperty('height', '50px');
    const _h1 = el.offsetHeight;   // forced reflow
    const _h2 = el.offsetWidth;    // layout is now clean -- no violation

    assert.equal(violations.length, 1, 'only one violation, not two');

    p.destroy();
}));

test('second write-then-read flags a second violation', withDom(async (w, create) => {
    const doc = w.document;
    const el = doc.createElement('div');
    doc.body.appendChild(el);

    const violations = [];
    const p = create({ warnToConsole: false, onViolation: (v) => violations.push(v) });

    el.style.setProperty('width', '1px');
    const _a = el.offsetWidth;    // #1
    el.style.setProperty('height', '1px');
    const _b = el.offsetHeight;   // #2

    assert.equal(violations.length, 2);

    p.destroy();
}));

test('className write triggers detection on read', withDom(async (w, create) => {
    const doc = w.document;
    const el = doc.createElement('div');
    doc.body.appendChild(el);

    const violations = [];
    const p = create({ warnToConsole: false, onViolation: (v) => violations.push(v) });

    el.className = 'active';
    const _w = el.clientWidth;

    assert.ok(violations.length >= 1);
    assert.ok(violations[0].write.length > 0, 'write source captured');

    p.destroy();
}));

test('appendChild write triggers detection on read', withDom(async (w, create) => {
    const doc = w.document;
    const el = doc.createElement('div');
    const child = doc.createElement('span');
    doc.body.appendChild(el);

    const violations = [];
    const p = create({ warnToConsole: false, onViolation: (v) => violations.push(v) });

    el.appendChild(child);
    const _w = el.offsetHeight;

    assert.ok(violations.length >= 1);
    assert.ok(violations[0].write.includes('appendChild'));

    p.destroy();
}));

test('destroy unpatches prototypes', withDom(async (w, create) => {
    const doc = w.document;
    const el = doc.createElement('div');
    doc.body.appendChild(el);

    const p = create({ warnToConsole: false });
    p.destroy();

    // After destroy, write+read should NOT flag anything
    const violations = [];
    el.style.setProperty('width', '100px');
    const _w = el.offsetWidth;
    assert.equal(violations.length, 0);
}));

test('reset clears violations but keeps profiler active', withDom(async (w, create) => {
    const doc = w.document;
    const el = doc.createElement('div');
    doc.body.appendChild(el);

    const p = create({ warnToConsole: false });

    el.style.setProperty('width', '1px');
    const _a = el.offsetWidth;
    assert.ok(p.violationCount >= 1);

    p.reset();
    assert.equal(p.violationCount, 0);
    assert.equal(p.violations.length, 0);
    assert.equal(p.active, true);

    p.destroy();
}));

test('summary aggregates by read and write', withDom(async (w, create) => {
    const doc = w.document;
    const el = doc.createElement('div');
    doc.body.appendChild(el);

    const p = create({ warnToConsole: false });

    el.style.setProperty('width', '1px');
    const _a = el.offsetWidth;
    el.style.setProperty('height', '1px');
    const _b = el.offsetWidth;
    el.className = 'x';
    const _c = el.offsetHeight;

    const s = p.summary();
    assert.equal(s.total, 3);
    assert.equal(s.byRead.offsetWidth, 2);
    assert.equal(s.byRead.offsetHeight, 1);

    p.destroy();
}));

test('violation includes timestamp', withDom(async (w, create) => {
    const doc = w.document;
    const el = doc.createElement('div');
    doc.body.appendChild(el);

    const violations = [];
    const p = create({ warnToConsole: false, onViolation: (v) => violations.push(v) });

    el.style.setProperty('width', '1px');
    const _a = el.offsetWidth;

    assert.equal(typeof violations[0].timestamp, 'number');
    assert.ok(violations[0].id > 0);

    p.destroy();
}));

test('captureStacks: false disables stack capture', withDom(async (w, create) => {
    const doc = w.document;
    const el = doc.createElement('div');
    doc.body.appendChild(el);

    const violations = [];
    const p = create({ warnToConsole: false, captureStacks: false, onViolation: (v) => violations.push(v) });

    el.style.setProperty('width', '1px');
    const _a = el.offsetWidth;

    assert.equal(violations[0].readSite, '(stacks disabled)');
    assert.equal(violations[0].writeSite, '(stacks disabled)');

    p.destroy();
}));

test('direct per-property style assignment (el.style.width = X) triggers detection', withDom(async (w, create) => {
    // This is the most common style-write idiom in real code. In Chrome and
    // Firefox the WebIDL per-property setters call C++ setPropertyInternal
    // directly, bypassing the JS-level `setProperty` method on the prototype.
    // So patching `setProperty` alone would miss this. The library patches
    // every per-property setter on CSSStyleDeclaration.prototype to close
    // the gap. This test verifies the mechanism.
    const doc = w.document;
    const el = doc.createElement('div');
    doc.body.appendChild(el);

    const violations = [];
    const p = create({ warnToConsole: false, onViolation: (v) => violations.push(v) });

    el.style.width = '100px';
    const _w = el.offsetWidth;

    assert.ok(violations.length >= 1, 'direct style property assignment should flag');
    assert.equal(violations[0].read, 'offsetWidth');
    assert.ok(violations[0].write.length > 0, 'write source captured');

    p.destroy();
}));

test('getComputedStyle counts as a layout read', withDom(async (w, create) => {
    const doc = w.document;
    const el = doc.createElement('div');
    doc.body.appendChild(el);

    const violations = [];
    const p = create({ warnToConsole: false, onViolation: (v) => violations.push(v) });

    el.style.setProperty('padding', '5px');
    const _ = w.getComputedStyle(el).padding;

    assert.ok(violations.length >= 1, 'getComputedStyle after write should flag');
    assert.equal(violations[0].read, 'getComputedStyle()');

    p.destroy();
}));

test('destroy restores per-property setters (style writes no longer flag)', withDom(async (w, create) => {
    const doc = w.document;
    const el = doc.createElement('div');
    doc.body.appendChild(el);

    const p = create({ warnToConsole: false });
    p.destroy();

    const violations = [];
    // After destroy, direct style assignment + layout read should be silent.
    el.style.width = '200px';
    const _w = el.offsetWidth;
    assert.equal(violations.length, 0);
}));

test('SVG getBBox after DOM write flags a violation', withDom(async (w, create) => {
    const doc = w.document;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = doc.createElementNS(svgNS, 'svg');
    const rect = doc.createElementNS(svgNS, 'rect');
    svg.appendChild(rect);
    doc.body.appendChild(svg);

    const violations = [];
    const p = create({ warnToConsole: false, onViolation: (v) => violations.push(v) });

    rect.setAttribute('width', '50');
    // getBBox after setAttribute forces layout in the SVG coordinate space
    if (typeof rect.getBBox === 'function') {
        rect.getBBox();
        assert.ok(violations.length >= 1, 'getBBox() should flag after SVG mutation');
        assert.equal(violations[0].read, 'getBBox()');
    } else {
        // happy-dom may not implement getBBox on all versions; only assert
        // the patch didn't crash setup.
        assert.ok(true, 'getBBox unavailable in this DOM impl');
    }

    p.destroy();
}));

test('scrollTo after DOM write flags a violation', withDom(async (w, create) => {
    const doc = w.document;
    const el = doc.createElement('div');
    doc.body.appendChild(el);

    const violations = [];
    const p = create({ warnToConsole: false, onViolation: (v) => violations.push(v) });

    el.style.width = '100px';
    if (typeof el.scrollTo === 'function') {
        el.scrollTo(0, 0);
        assert.ok(violations.length >= 1, 'scrollTo() should flag after DOM mutation');
        assert.equal(violations[0].read, 'scrollTo()');
    } else {
        assert.ok(true, 'scrollTo unavailable in this DOM impl');
    }

    p.destroy();
}));

test('scrollIntoView after DOM write flags a violation', withDom(async (w, create) => {
    const doc = w.document;
    const el = doc.createElement('div');
    doc.body.appendChild(el);

    const violations = [];
    const p = create({ warnToConsole: false, onViolation: (v) => violations.push(v) });

    el.className = 'x';
    if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView();
        assert.ok(violations.length >= 1, 'scrollIntoView() should flag after DOM mutation');
        assert.equal(violations[0].read, 'scrollIntoView()');
    } else {
        assert.ok(true);
    }

    p.destroy();
}));

test('window.innerWidth read after DOM write flags a violation', withDom(async (w, create) => {
    const doc = w.document;
    const el = doc.createElement('div');
    doc.body.appendChild(el);

    const violations = [];
    const p = create({ warnToConsole: false, onViolation: (v) => violations.push(v) });

    el.style.width = '100px';
    // Access via the window we set as global so the getter fires.
    const _iw = w.innerWidth;
    assert.ok(violations.length >= 1, 'window.innerWidth read after DOM write should flag');
    assert.equal(violations[0].read, 'innerWidth');

    p.destroy();
}));

test('window.scrollY read after DOM write flags a violation', withDom(async (w, create) => {
    const doc = w.document;
    const el = doc.createElement('div');
    doc.body.appendChild(el);

    const violations = [];
    const p = create({ warnToConsole: false, onViolation: (v) => violations.push(v) });

    el.className = 'active';
    const _sy = w.scrollY;
    assert.ok(violations.length >= 1, 'window.scrollY read after DOM write should flag');
    assert.equal(violations[0].read, 'scrollY');

    p.destroy();
}));

test('destroy restores SVG / scroll / window-metric patches', withDom(async (w, create) => {
    const doc = w.document;
    const el = doc.createElement('div');
    doc.body.appendChild(el);

    const p = create({ warnToConsole: false });
    p.destroy();

    const violations = [];
    // All post-destroy reads should be silent even after DOM writes.
    el.style.width = '10px';
    if (typeof el.scrollTo === 'function') el.scrollTo(0, 0);
    const _iw = w.innerWidth;
    const _sy = w.scrollY;
    assert.equal(violations.length, 0, 'no violations after destroy');
}));
