// Engine constants. Panel-authored knobs (simRate, sendRate, maxPlayers) arrive on the
// manifest; the rest are engine constants, not creator knobs (DESIGN §4.4).

/** Simulation rate options and default (api_design.md §1). `dt` inside a tick is 1/simRate. */
export const SIM_RATES = [20, 30, 60] as const;
export const DEFAULT_SIM_RATE = 60;

/** Replication rate options and default. Governs the transform channel's cadence (§5.1). */
export const SEND_RATES = [10, 20, 30] as const;
export const DEFAULT_SEND_RATE = 20;

/**
 * Consecutive throws that disable a handler (DESIGN §4.4). Consecutive is the operative
 * word: any success resets the counter, so a handler throwing on rare input is never
 * disabled. An engine constant, not a creator knob.
 */
export const BREAKER_THRESHOLD = 100;

/** Max `send` re-entry depth before the dispatcher aborts the chain (§4.3, §5.8). */
export const MAX_SEND_DEPTH = 64;

/** Speech-bubble text cap; longer strings truncate rather than growing unbounded (§3.7). */
export const MAX_BUBBLE_LENGTH = 200;

/**
 * How far back a historical spatial query (`asSeen`) may reach, in milliseconds
 * (DESIGN §8.1). The server retains a ring of transform captures roughly this long
 * so a client's shot resolves against the world it saw a send interval ago; a
 * client-reported view tick outside this window is clamped and reported.
 */
export const MAX_REWIND_MS = 250;

/** The session-and-world configuration a manifest supplies. */
export interface EngineConfig {
    simRate: number;
    sendRate: number;
    maxPlayers: number;
}

/** Fills a partial config with the documented defaults. */
export function resolveConfig(partial?: Partial<EngineConfig>): EngineConfig {
    return {
        simRate: partial?.simRate ?? DEFAULT_SIM_RATE,
        sendRate: partial?.sendRate ?? DEFAULT_SEND_RATE,
        maxPlayers: partial?.maxPlayers ?? 8,
    };
}
