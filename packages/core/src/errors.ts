// A handler throw is caught and logged because the tick stays coherent either way; wiring and
// the destroy drain abort instead, since a half-mutated structure only fails again later.

/** A load-time / structural rejection. Fatal — fails the load or aborts the run. */
export class LoadError extends Error {
    override readonly name = 'LoadError';
}

/** A determinism violation, thrown rather than logged because divergence is not a local bug. */
export class DeterminismError extends Error {
    override readonly name = 'DeterminismError';
}

/** The phase a fatal engine error occurred in, carried in the log record. */
export type EnginePhase = 'wire' | 'destroy' | 'load';

/** The fixed fields a caught handler throw is logged with. */
export interface HandlerErrorRecord {
    scriptClass: string;
    method: string;
    hostId: string;
    tick: number;
    event: string;
    stack: string;
}

/** Canned diagnostic texts, so each rule's message is written in exactly one place. */
export const Diagnostics = {
    mathRandomInSynced:
        'Math.random() is non-deterministic and cannot be used in a SyncedScript — ' +
        'use the seeded `random` stream.',
    transcendentalInSynced: (fn: string) =>
        `Math.${fn}() is implementation-approximated and cannot be used in a SyncedScript — ` +
        `use \`${fn}\` from @platform/math.`,
    viewportInSynced:
        'camera.viewport depends on the client window and cannot be read from a SyncedScript ' +
        '— two aspect ratios would diverge.',
    storageInSynced:
        'Storage and Leaderboard reads are ServerScript-only — a SyncedScript has no ' +
        'authoritative copy to agree with.',
} as const;
