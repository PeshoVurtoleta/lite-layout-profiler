# ReflowForge

A browser viewer for `@zakkster/lite-layout-profiler` reports. The layout
analogue of GCForge.

Open `index.html` in any browser, then drop a `layout.json`, choose a file,
paste the JSON, or fetch a URL. ReflowForge reads a `lite-layout-report/1`
envelope -- the output of `formatJson(report)` or `lite-layout-gate --json` --
and renders the verdict, the counted/excluded tallies, the per-violation
reasons, and the cost lane.

It runs entirely in your browser. Nothing is uploaded, and there is no build
step and no dependency: a single self-contained HTML file.

## What it reads

The `lite-layout-report/1` envelope:

```json
{
  "schema": "lite-layout-report/1",
  "version": "1.7.0",
  "generatedAt": "2026-07-31T00:00:00.000Z",
  "verdict": "fail",
  "report": {
    "ok": false,
    "verified": true,
    "total": 5,
    "counted": 4,
    "excluded": 1,
    "excludedBy": { "reads": 0, "writes": 0, "sites": 1, "expected": 0 },
    "cost": { "measured": 4, "unmeasured": 0, "totalMs": 2.84, "maxMs": 1.21 },
    "violations": [
      { "metric": "maxReflows", "limit": 0, "actual": 4,
        "reason": "maxReflows: 4 forced reflows counted, limit 0" }
    ]
  }
}
```

A bare `checkNoReflow` report (the same object without the envelope) is also
accepted.

## Report-only, and fail-closed

ReflowForge renders what the gate produced; it does not run the profiler. Layout
profiling patches real DOM getters and needs a real layout engine, which a static
viewer does not have -- so the browser gates and serialises, and this viewer
reads the result.

The verdict is derived from the report's `ok`/`verified` booleans, not taken on
faith from the envelope. `verified` must be exactly `true` for a definitive
verdict; anything else is inconclusive. If an envelope states a verdict that
disagrees with the booleans, ReflowForge shows the derived one and notes the
mismatch -- the booleans are the source of truth.

Two documents get a specific rejection rather than a generic error, because both
are real artifacts a user might paste by mistake:

- A **summary** (`profiler.summary()`) has the recording data but no verdict.
  ReflowForge redirects you to gate it first with `checkNoReflow`.
- A **lite-gc-profiler report** belongs in GCForge, not here.

## Where it lives

This viewer ships to the repository's `viewer/` directory and to GitHub Pages.
It is excluded from the npm package (`files[]` is a whitelist), the same way the
`demo/` directory is.

## License

Copyright (c) 2026 Zahary Shinikchiev. MIT License.
