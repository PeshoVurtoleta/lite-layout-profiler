# Mock reports

Sample `lite-layout-report/1` envelopes -- one for every verdict the tool can
reach -- for eyeballing output, demoing the CLI, and dropping into the
[ReflowForge viewer](../viewer/). They are checked into the repo but excluded
from the npm package (`files[]` is a whitelist), the same as `demo/` and
`viewer/`.

Each is either produced by the real profiler + `formatJson`, or (for the two
stalls a coarse Node clock cannot reproduce) hand-built and wrapped by the real
`formatJson`, so `schema` / `version` / `verdict` are always authoritative.
`test/14-mocks.test.mjs` drives every file through the CLI gate and the viewer
classifier and checks the shape against live `formatJson`, so none of these can
silently drift.

| file | verdict | CLI exit | what it shows |
| --- | --- | --- | --- |
| `pass.json` | pass | 0 | a clean run, zero forced reflows |
| `fail-reflows.json` | fail | 1 | three forced reflows against a zero budget (`maxReflows`) |
| `thrash.json` | fail | 1 | a getter looped in one task, caught by `maxPerTask` |
| `fail-cost.json` | fail | 1 | a single 12 ms stall over a 4 ms `maxCostMs` budget |
| `fail-raf.json` | fail | 1 | reflows inside `requestAnimationFrame` (`maxInRaf`) |
| `inconclusive-foreign.json` | inconclusive | 2 | a second instance patched on top -- coverage not clean |
| `inconclusive-realm-hole.json` | inconclusive | 2 | an added realm with a non-configurable setter -- a hole |
| `reject-summary.json` | -- | 3 | a bare `summary()`: no verdict; gate it first |
| `reject-gc-report.json` | -- | 3 | a `lite-gc-report/1`: belongs in GCForge, not here |

Gate one from the command line:

```sh
npx lite-layout-gate mocks/fail-reflows.json
npx lite-layout-gate mocks/inconclusive-foreign.json --format markdown
```
