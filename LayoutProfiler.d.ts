export declare const VERSION: string;

export interface Violation {
    id: number;
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
    /** Timestamp (performance.now or Date.now). */
    timestamp: number;
}

export interface ViolationSummary {
    total: number;
    stored: number;
    byRead: Record<string, number>;
    byWrite: Record<string, number>;
}

export interface LayoutProfilerOptions {
    /** Max stored violations. Default 200. */
    maxViolations?: number;
    /** Called on each forced reflow. */
    onViolation?: (v: Violation) => void;
    /** Capture call stacks. Default true. Set false to reduce overhead. */
    captureStacks?: boolean;
    /** Log console.warn per violation. Default true. */
    warnToConsole?: boolean;
    /** Stack frame substrings to ignore. */
    ignorePatterns?: string[];
}

export interface LayoutProfiler {
    /** All recorded violations. */
    readonly violations: Violation[];
    /** Total violation count (may exceed stored if maxViolations capped). */
    readonly violationCount: number;
    /** Whether the profiler is active (false after destroy). */
    readonly active: boolean;
    /** Unpatch all prototypes and deactivate. */
    destroy(): void;
    /** Clear violations but keep profiler active. */
    reset(): void;
    /** Aggregate violations by read property and write source. */
    summary(): ViolationSummary;
}

/**
 * Create a forced-reflow detector. Patches Element/HTMLElement prototypes
 * to flag read-after-write within the same synchronous task.
 *
 * Dev-mode only. NOT zero-GC (allocates per violation, captures stacks).
 * Ship behind a __DEV__ flag or strip from production builds.
 */
export function createLayoutProfiler(options?: LayoutProfilerOptions): LayoutProfiler;
