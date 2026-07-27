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
    'raf' | 'timer' | 'microtask' | 'ro-callback' | 'event' | 'unknown' | 'unobserved';

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
    timestamp: number;
}

/** Per-phase reflow counts over the whole run (v1.3). */
export interface PhaseCounts {
    raf: number;
    timer: number;
    microtask: number;
    roCallback: number;
    event: number;
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
    /** False when at least one present target could not be instrumented. */
    complete: boolean;
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
    /** Serialisable snapshot for the gate. */
    summary(): ViolationSummary;
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
    excludedBy: { reads: number; writes: number; sites: number };
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
