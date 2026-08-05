// The engine's error surface. Two distinct failure regimes (DESIGN §4.4):
//
//   catch  — a handler invocation is the unit of failure; the throw is logged and the rest
//            of the tick proceeds. The state is coherent: a handler ran or it did not.
//   abort  — wire and destroy-drain leave a structure half-mutated (a host record matching
//            no declaration, an entity half-removed from the indexes), so continuing
//            produces a second, unrelated failure. These are fatal.
//
// The general rule: catch where the failure is local and the state coherent; abort where
// it leaves a structure half-mutated.

/** A load-time / structural rejection. Fatal — fails the load or aborts the run. */
export class LoadError extends Error {
    override readonly name = 'LoadError';
}

/**
 * A rule a source-level AST pass will eventually catch at load (DESIGN §3.4, §9.1). Until
 * that pass exists each such rule throws at runtime with the message the load error will
 * carry, so the diagnostic text is written once. Thrown, not logged, because these are
 * determinism/trust violations rather than ordinary handler bugs.
 */
export class DeterminismError extends Error {
    override readonly name = 'DeterminismError';
}

/** The phase a fatal engine error occurred in, carried in the log record (§4.4). */
export type EnginePhase = 'wire' | 'destroy' | 'load';

/** The fixed fields a caught handler throw is logged with (§4.4). */
export interface HandlerErrorRecord {
    scriptClass: string;
    method: string;
    hostId: string;
    tick: number;
    event: string;
    stack: string;
}

/** Canned diagnostics for the two-tier rules, so the text is written exactly once. */
export const Diagnostics = {
    mathRandomInSynced:
        'Math.random() is non-deterministic and cannot be used in a SyncedScript — ' +
        'use the seeded `random` stream (DESIGN §9.1).',
    transcendentalInSynced: (fn: string) =>
        `Math.${fn}() is implementation-approximated and cannot be used in a SyncedScript — ` +
        `use \`${fn}\` from @platform/math (DESIGN §9.1).`,
    viewportInSynced:
        'camera.viewport depends on the client window and cannot be read from a SyncedScript ' +
        '— two aspect ratios would diverge (DESIGN §3.4).',
    storageInSynced:
        'Storage and Leaderboard reads are ServerScript-only — a SyncedScript has no ' +
        'authoritative copy to agree with (DESIGN §5.4).',
} as const;
