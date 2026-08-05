export declare const VERSION: string;

/**
 * The complete closed vocabulary of read names this build can emit.
 * `allowReads` entries are validated against it.
 */
export declare const READ_NAMES: readonly string[];

export interface Violation {
    id: number;
    /** Epoch of the synchronous block this reflow occurred in. */
    taskId: number;
    /** Layout getter that forced the reflow. */
    read: string;
    /** DOM write that dirtied layout. */
    write: string;
    /** Parsed call site of the read. */
    readSite: string;
    /** Parsed call site of the write. */
    writeSite: string;
    /** Full stack at the read. */
    readStack: string;
    /** Full stack at the write. */
    writeStack: string;
    /** Milliseconds spent inside the forced layout, or null if unmeasurable. */
    costMs: number | null;
    /** True when the stall did not clear the clock's granularity. */
    belowGranularity: boolean;
    /** Timestamp (performance.now or Date.now). */
    timestamp: number;
}

/** A recorded reflow as carried in a summary: no stacks, JSON-safe. */
/** The scheduler a reflow fired under. 'unobserved' when phases:false; */
/** 'unknown' when phases:true but no wrapped scheduler was active. */
export type ReflowPhase =
    'raf' | 'timer' | 'microtask' | 'ro-callback' | 'unknown' | 'unobserved';

export interface ViolationRecord {
    id: number;
    taskId: number;
    read: string;
    write: string;
    readSite: string;
    writeSite: string;
    costMs: number | null;
    belowGranularity: boolean;
    /** The scheduler this reflow fired under (v1.3). */
    phase: ReflowPhase;
    /** True if inside a ResizeObserver callback that had already written (v1.3). */
    roFeedback: boolean;
    /**
     * True if this reflow fired inside a profiler.expected(fn) region -- a
     * deliberate measurement the gate may excuse via allowExpected (v1.5). The
     * record is kept either way; the flag only labels, the gate decides.
     */
    expected: boolean;
    timestamp: number;
}

/** Per-phase reflow counts over the whole run (v1.3). */
export interface PhaseCounts {
    raf: number;
    timer: number;
    microtask: number;
    roCallback: number;
    unknown: number;
    unobserved: number;
}

/** A collapsed read-after-write loop: identical tuple repeating in one task. */
export interface ThrashGroup {
    read: string;
    write: string;
    readSite: string;
    writeSite: string;
    taskId: number;
    phase: ReflowPhase;
    roFeedback: boolean;
    count: number;
    /** Sum of measured member costs, or null if none were measured. */
    costMs: number | null;
    unmeasuredMembers: number;
}

/** Cost aggregates. Every total is null, not zero, when nothing was measured. */
export interface CostSummary {
    /** Smallest positive delta the clock reports. Null if undeterminable. */
    resolutionMs: number | null;
    measured: number;
    unmeasured: number;
    totalMs: number | null;
    maxMs: number | null;
    avgMs: number | null;
    p99Ms: number | null;
}

/** What the patch net actually covers on this host. */
export interface PatchCoverage {
    /** Targets successfully instrumented. */
    applied: number;
    /** Targets present but refusing to be patched. Any failure is a hole. */
    failed: number;
    /** Targets absent from this host. Not a hole: nothing can flow through them. */
    skipped: number;
    /**
     * How many realms are instrumented (v1.7): 1 for the main realm only, more
     * when addRealm has added iframe/synthetic realms. An unusable or
     * cross-origin realm is not counted -- it is a documented blind spot, not
     * coverage. (0 only in the no-DOM stub summary.)
     */
    realms: number;
    /**
     * Targets verifiably already wrapped by another lite-layout-profiler
     * instance when we instrumented (v1.4). We still wrap on top and detect
     * reflows, but we do not cleanly own the path, so coverage is not complete.
     * Only BRANDED foreign patches are counted -- an unbranded pre-existing
     * wrapper cannot be told apart from a host's pristine impl by inspection.
     */
    foreign: number;
    /**
     * False when at least one present target could not be instrumented OR was
     * verifiably foreign-wrapped. The gate's "incomplete coverage ->
     * unverifiable" path consumes this, so a foreign patch flips affected
     * per-record rules to unverifiable with no new rule key.
     */
    complete: boolean;
    /**
     * Per-target provenance for every non-clean target (v1.4): 'foreign'
     * (verified other-instance wrapper) or 'unknown' (an unbranded function a
     * patch helper could positively flag as ambiguous). Clean ('owned') targets
     * are omitted to keep the map small.
     */
    provenance: { [target: string]: 'foreign' | 'unknown' };
    /** Up to 20 labels naming what failed. */
    failures: string[];
}

export interface ViolationSummary {
    /** Exact number of reflows recorded, even if storage was capped. */
    total: number;
    /** Number of records actually retained. */
    stored: number;
    /** True when the storage cap dropped records. Poisons per-record rules. */
    truncated: boolean;
    /** Whether call sites are real. `ignoreSites` is unverifiable without them. */
    stacks: boolean;
    byRead: Record<string, number>;
    byWrite: Record<string, number>;
    byTask: Record<string, number>;
    taskCount: number;
    patched: PatchCoverage;
    /** Per-phase reflow counts (v1.3). */
    phases: PhaseCounts;
    /** Whether requestAnimationFrame was actually wrapped -- what maxInRaf needs. */
    phasesObserved: boolean;
    /** Recorded reflows that fired inside a profiler.expected(fn) region (v1.5). */
    expected: number;
    /** Collapsed read-after-write loops (count > 1), worst first (v1.3). */
    thrash: ThrashGroup[];
    /** Worst collapsed count in any one task -- what maxThrash gates (v1.3). */
    maxThrashCount: number;
    cost: CostSummary;
    /** Snapshot of retained records. Serialisable; consumed by the gate. */
    records: ViolationRecord[];
}

export interface LayoutProfilerOptions {
    /** Max retained records. Integer 1..1000000. Default 200. */
    maxStored?: number;
    /** @deprecated Pre-1.1 name for `maxStored`. Still honoured. */
    maxViolations?: number;
    /** Called on each forced reflow. */
    onViolation?: (v: Violation) => void;
    /** Capture call stacks. Default true. Set false to reduce overhead. */
    captureStacks?: boolean;
    /** Time each forced reflow and probe the clock floor at init. Default true. */
    measureCost?: boolean;
    /** Monotonic millisecond clock. Defaults to performance.now(). */
    clock?: () => number;
    /** Log console.warn per violation. Default true. */
    warnToConsole?: boolean;
    /** Stack frame substrings to drop at capture time (never recorded). */
    ignorePatterns?: string[];
    /**
     * Wrap the schedulers (rAF, timers, microtask, ResizeObserver) so each
     * reflow is attributed to the phase it fired under, enabling maxInRaf.
     * Opt-in (default false): wrapping touches globals every callback runs
     * through. With it off, every record is phase 'unobserved' and maxInRaf
     * gates as unverifiable. Thrash collapsing does NOT require it.
     */
    phases?: boolean;
}

export interface LayoutProfiler {
    /** Retained violations with stacks, oldest first. A stable snapshot. */
    readonly violations: Violation[];
    /** Total violation count (may exceed stored if the cap was hit). */
    readonly violationCount: number;
    /** Whether the profiler is active (false after destroy). */
    readonly active: boolean;
    /** Unpatch all prototypes and deactivate. */
    destroy(): void;
    /** Clear violations but keep profiler active. */
    reset(): void;
    /**
     * Run `fn` inside a deliberate-measurement scope (v1.5). Reflows that fire
     * while control is inside it are stamped `expected: true`, so a gate with
     * allowExpected can excuse them without silencing the same read elsewhere.
     * Returns fn's return value. Nests; restores depth in a finally so a throw
     * cannot strand it. Synchronous scope only -- an await inside fn escapes it.
     */
    expected<T>(fn: () => T): T;
    /**
     * Instrument an additional realm (v1.7): an iframe's `contentWindow`
     * (same-origin), or a realm-descriptor object for synthetic/testing use.
     * A cross-origin frame or an unusable source degrades to an unavailable
     * handle -- never throws, and does not count toward coverage. Returns a
     * handle whose `remove()` restores just this realm's patches (destroy()
     * still tears down everything).
     */
    addRealm(source: Window | RealmDescriptor): RealmHandle;
    /** Serialisable snapshot for the gate. */
    summary(): ViolationSummary;
}

/**
 * A realm-descriptor: the bundle of constructors + window a set of patches
 * binds to (v1.7). All fields optional; a minimal descriptor yields fewer
 * targets, the same way a missing global does. An iframe's contentWindow
 * satisfies the Window overload; this object form is for synthetic realms.
 */
export interface RealmDescriptor {
    Element?: typeof Element;
    HTMLElement?: typeof HTMLElement;
    Node?: typeof Node;
    CSSStyleDeclaration?: typeof CSSStyleDeclaration;
    DOMTokenList?: typeof DOMTokenList;
    SVGGraphicsElement?: unknown;
    window?: unknown;
}

/** Handle returned by addRealm (v1.7). */
export interface RealmHandle {
    /** True if the realm was usable and instrumented. */
    readonly available: boolean;
    /** Why the realm was not instrumented, when available is false. */
    readonly reason?: 'inactive' | 'unusable_realm' | (string & {});
    /** The realm's index (1-based), or -1 if unavailable. */
    readonly realmIndex: number;
    /** Restore just this realm's patches. Idempotent; safe if already gone. */
    remove(): void;
}

/**
 * Reflow budget rules.
 *
 * Unknown keys throw a TypeError with a did-you-mean hint rather than being
 * ignored: a misspelled rule is a rule that silently never fires.
 */
export interface ReflowRules {
    /** Max counted reflows over the whole run. Default 0. */
    maxReflows?: number;
    /** Max counted reflows within any one synchronous block. Default unlimited. */
    maxPerTask?: number;
    /** Max milliseconds for the worst single forced reflow. Default unlimited. */
    maxCostMs?: number;
    /** Max total milliseconds across all counted reflows. Default unlimited. */
    maxTotalCostMs?: number;
    /**
     * Max forced reflows inside requestAnimationFrame callbacks (frame-killers).
     * Default unlimited. Unverifiable unless the run was recorded with
     * { phases: true } and rAF was present. maxInRaf: 0 is the "never force
     * layout during render" assertion.
     */
    maxInRaf?: number;
    /**
     * Max times an identical (read, write, site, site) tuple may repeat within
     * one task. Default unlimited. maxThrash: 1 forbids any read-after-write
     * loop. Does not require { phases: true }.
     */
    maxThrash?: number;
    /** Read names to exclude. Validated against READ_NAMES. Trailing `()` optional. */
    allowReads?: string[];
    /** Write sources to exclude. Prefix match. */
    allowWrites?: string[];
    /** Call-site substrings to exclude. Matches readSite or writeSite. */
    ignoreSites?: string[];
    /**
     * Exclude reflows that fired inside a profiler.expected(fn) scope (v1.5).
     * Excludes by DYNAMIC SCOPE, not read name, so the same read is allowed
     * where you marked it deliberate and still fails elsewhere. Unverifiable on
     * a pre-1.5 summary (records without the `expected` flag). Default false.
     */
    allowExpected?: boolean;
}

/** One breached rule. Shape shared with lite-gc-profiler's checkNoGc. */
export interface RuleViolation {
    metric: string;
    limit: number | null;
    actual: number | string;
    reason: string;
}

export interface GateReport {
    /** True only if every rule passed and every rule was verifiable. */
    ok: boolean;
    /** False when a rule could not be evaluated from the supplied evidence. */
    verified: boolean;
    /** Raw recorded total, before exclusions. */
    total: number;
    /** Reflows counted against the budget, after exclusions. */
    counted: number;
    excluded: number;
    excludedBy: { reads: number; writes: number; sites: number; expected: number };
    /** Cost of counted reflows. Null when the summary carried no records. */
    cost: {
        measured: number;
        unmeasured: number;
        totalMs: number | null;
        maxMs: number | null;
    } | null;
    violations: RuleViolation[];
}

export declare class ReflowBudgetError extends Error {
    readonly name: 'ReflowBudgetError';
    readonly report: GateReport;
    readonly violations: RuleViolation[];
    constructor(report: GateReport);
}

/**
 * Evaluate a recorded run against a reflow budget.
 *
 * Fail-closed: a rule that needs per-record data and cannot get it -- records
 * truncated by the storage cap, or call sites absent because captureStacks was
 * off -- fails as unverifiable rather than passing on incomplete evidence.
 */
export declare function checkNoReflow(
    summary: ViolationSummary,
    rules?: ReflowRules
): GateReport;

/** checkNoReflow, but throws ReflowBudgetError when the budget is breached. */
export declare function assertNoReflow(
    summary: ViolationSummary,
    rules?: ReflowRules
): GateReport;

/** The pass/fail/inconclusive verdict, derived from a report's ok/verified. */
export type GateVerdict = 'pass' | 'fail' | 'inconclusive';

/**
 * Derive the verdict from a checkNoReflow report (v1.6). Pure projection of
 * ok/verified: verified===false is inconclusive, a verified breach is fail,
 * a verified clean run is pass.
 */
export declare function _verdictOf(report: GateReport): GateVerdict;

/** Human-readable console output with a verdict line and per-violation reasons (v1.6). */
export declare function formatConsole(report: GateReport): string;

/**
 * The layout.json envelope (v1.6): a schema-versioned JSON string carrying the
 * derived verdict and the raw checkNoReflow report. Schema lite-layout-report/1.
 */
export declare function formatJson(report: GateReport): string;

/** PR-comment-ready GitHub-flavored markdown table (v1.6). */
export declare function formatMarkdown(report: GateReport): string;

/** GitHub Actions workflow annotations: ::error per violation, ::warning on inconclusive (v1.6). */
export declare function formatGithubAnnotations(report: GateReport): string;

/**
 * Create a forced-reflow detector. Patches Element/HTMLElement prototypes
 * to flag read-after-write within the same synchronous task.
 *
 * Dev-mode only. NOT zero-GC (allocates per violation, captures stacks).
 * Ship behind a __DEV__ flag or strip from production builds.
 */
export declare function createLayoutProfiler(
    options?: LayoutProfilerOptions
): LayoutProfiler;
