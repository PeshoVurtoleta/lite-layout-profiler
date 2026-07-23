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
export interface ViolationRecord {
    id: number;
    taskId: number;
    read: string;
    write: string;
    readSite: string;
    writeSite: string;
    costMs: number | null;
    belowGranularity: boolean;
    timestamp: number;
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
    cost: CostSummary;
    /** Snapshot of retained records. Serialisable; consumed by the gate. */
    records: ViolationRecord[];
}

export interface LayoutProfilerOptions {
    /** Max retained records. Default 200. */
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
