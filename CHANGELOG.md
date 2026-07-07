# Changelog

## [1.0.0] - 2026-07-07

Initial release. Dev-mode forced-reflow detector.

### Added

- `createLayoutProfiler(options?)` -- patch Element/HTMLElement/Node/
  CSSStyleDeclaration prototypes to detect read-after-write forced reflows.
- Write tracking: `style.setProperty`, `style.removeProperty`, `style.cssText`,
  every per-property style setter on `CSSStyleDeclaration.prototype`
  (`style.width = 'X'` etc. -- ~400 properties patched at init),
  `className`, `classList.*`, `setAttribute`, `appendChild`, `innerHTML`,
  `textContent`, and more.
- Read detection: `offsetWidth/Height/Top/Left`, `clientWidth/Height`,
  `scrollWidth/Height`, `getBoundingClientRect`, `getComputedStyle`,
  `SVGGraphicsElement.getBBox` / `getCTM` / `getScreenCTM` for SVG
  dataviz code, `Element` and `window` scroll methods
  (`scrollIntoView`, `scrollTo`, `scrollBy`, `scroll`) which force
  layout to compute their destination, and `window.innerWidth`,
  `innerHeight`, `scrollX`, `scrollY`, `pageXOffset`, `pageYOffset`.
- Call-site attribution via `Error.stack` with parsed `readSite`/`writeSite`.
  Requires unminified code or sourcemaps for readable attribution;
  set `captureStacks: false` in busy environments to skip the
  per-write stack allocation.
- `onViolation` callback, `console.warn` logging, `ignorePatterns` filter.
- `summary()` aggregation by read property and write source.
- `destroy()` cleanly unpatches all prototypes in reverse order.
- `reset()` clears violations without unpatching.
- No-op profiler in non-browser environments (safe to import in SSR/node).
- Full `LayoutProfiler.d.ts`. 14 tests (3 node + 11 happy-dom).
- Interactive demo with six thrash patterns and live violation log.
