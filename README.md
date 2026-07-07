# @zakkster/lite-layout-profiler

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-layout-profiler.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-layout-profiler)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Hot%20path-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-layout-profiler?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-layout-profiler)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-layout-profiler?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-layout-profiler)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-layout-profiler?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-layout-profiler)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

> Dev-mode forced-reflow detector. The #1 silent frame killer, made visible.

Patches layout-triggering getters (`offsetWidth`, `getBoundingClientRect`, `getComputedStyle`, etc.), tracks DOM writes that invalidate layout, and flags read-after-write within the same synchronous task. Each violation is attributed to a call site via `Error.stack`.

```bash
npm install @zakkster/lite-layout-profiler
```

## Quick start

```js
import { createLayoutProfiler } from '@zakkster/lite-layout-profiler';

const profiler = createLayoutProfiler({
    onViolation(v) {
        // v.read:      'offsetWidth'
        // v.write:     'CSSStyleDeclaration.setProperty()'
        // v.readSite:  '  at updateSize (app.js:42:12)'
        // v.writeSite: '  at resizeHandler (app.js:38:5)'
    }
});

// Your app runs normally. Every forced reflow logs a console.warn
// with the read getter, write source, and call sites.

// Later:
console.table(profiler.summary().byRead);
profiler.destroy();  // unpatch everything
```

## What it detects

Forced synchronous layout happens when JavaScript writes to the DOM (changing styles, classes, tree structure) and then reads a layout property before the browser has a chance to batch the recalculation. The browser must stop and recalculate layout synchronously to return the correct value. This is invisible outside DevTools tracing and is the #1 cause of dropped frames in DOM-binding code.

```js
// BAD: write then read (forced reflow)
el.style.width = '100px';
const w = el.offsetWidth;  // browser must recalculate NOW

// GOOD: read then write (no forced reflow)
const w = el.offsetWidth;  // uses cached layout
el.style.width = (w + 10) + 'px';  // browser batches this
```

## What it patches

**Layout-triggering reads** (getters/methods that force synchronous layout):

- **HTML/Element metrics:** `offsetWidth`, `offsetHeight`, `offsetTop`, `offsetLeft`, `clientWidth`, `clientHeight`, `clientTop`, `clientLeft`, `scrollWidth`, `scrollHeight`, `scrollTop`, `scrollLeft`, `getBoundingClientRect()`
- **Computed style:** `getComputedStyle()`
- **SVG coordinate space:** `SVGGraphicsElement.getBBox()`, `getCTM()`, `getScreenCTM()` -- for reactive dataviz code
- **Scroll methods** (force layout to compute destination): `Element.scrollIntoView()`, `Element.scrollTo()`, `Element.scrollBy()`, `window.scrollTo()`, `window.scrollBy()`, `window.scroll()`
- **Window metrics:** `window.innerWidth`, `innerHeight`, `scrollX`, `scrollY`, `pageXOffset`, `pageYOffset`

**Layout-invalidating writes** (mutations that dirty layout):

`style.setProperty()`, `style.removeProperty()`, `style.cssText =`, **every per-property style setter** (`style.width = 'X'`, `style.height = 'Y'`, etc. -- ~400 properties patched at init), `className =`, `classList.add/remove/toggle/replace`, `setAttribute()`, `removeAttribute()`, `innerHTML =`, `outerHTML =`, `innerText =`, `textContent =`, `appendChild()`, `insertBefore()`, `removeChild()`, `replaceChild()`

Per-property style setters are patched separately from `setProperty()` because in real browsers the WebIDL per-property setters go through internal C++ that bypasses the JS-level `setProperty` method. Patching one does not catch the other; both are needed.

## API

### `createLayoutProfiler(options?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxViolations` | number | 200 | Cap on stored violations |
| `onViolation` | function | null | Called on each forced reflow |
| `captureStacks` | boolean | true | Capture call stacks for attribution |
| `warnToConsole` | boolean | true | Log console.warn per violation |
| `ignorePatterns` | string[] | [] | Stack frame substrings to ignore |

### `LayoutProfiler`

| Method / Property | Description |
|---|---|
| `violations` | Array of recorded violation objects |
| `violationCount` | Total count (may exceed stored if capped) |
| `active` | Whether the profiler is active |
| `destroy()` | Unpatch all prototypes, deactivate |
| `reset()` | Clear violations, keep profiler active |
| `summary()` | Aggregate by read property and write source |

### `Violation`

```ts
{
    id: number;
    read: string;           // 'offsetWidth', 'getBoundingClientRect()', etc.
    write: string;          // 'CSSStyleDeclaration.setProperty()', etc.
    readSite: string;       // parsed call site
    writeSite: string;      // parsed call site
    readStack: string;      // full Error.stack
    writeStack: string;
    timestamp: number;
}
```

## Dev-mode only

This library patches `Element.prototype`, `HTMLElement.prototype`, `Node.prototype`, `CSSStyleDeclaration.prototype`, and `window.getComputedStyle`. It allocates per violation (Error.stack capture). It is NOT zero-GC.

Ship behind a `__DEV__` flag:

```js
if (__DEV__) {
    import('@zakkster/lite-layout-profiler').then(m => m.createLayoutProfiler());
}
```

Or strip from production builds via your bundler's dead-code elimination.

## Stack attribution

`readSite` and `writeSite` are extracted from `Error.stack` at capture time by matching known function names (`markDirty`, `onRead`, `LayoutProfiler`) and skipping them to find the first user-code frame. This works reliably for local dev builds but has one caveat:

**Minified or mangled builds will produce unreadable attribution.** If your staging/dev environment strips function names (Terser, esbuild `--minify-identifiers`), the profiler still detects violations correctly, but `readSite` / `writeSite` will show minified frames like `at a.b (chunk.js:1:12345)`. Run this tool against unminified builds -- or ensure sourcemaps are loaded in DevTools -- for readable attribution.

For CI-style runs where you only need counts and not human-readable sites, set `captureStacks: false`. This also skips the `Error.stack` allocation on every DOM write, which is a real speedup in busy code.

## How it works

1. **Write tracking.** Patched write methods/setters set a `dirty` flag with the write source. A `queueMicrotask` callback clears the flag at the end of the current synchronous block.

2. **Read detection.** Patched layout getters check the `dirty` flag. If set, the read forces a synchronous layout recalculation -- a violation is recorded with both call sites.

3. **Self-clearing.** After a forced reflow, the browser HAS recalculated layout. The flag clears so subsequent reads (without intervening writes) don't double-flag.

4. **Clean unpatch.** `destroy()` restores every patched prototype property to its original descriptor, in reverse order.

## License

MIT (c) Zahary Shinikchiev
