// The manifest carries simRate, sendRate and maxPlayers; everything else here is an engine
// constant rather than a creator knob.

/** Default simulation rate; `dt` inside a tick is 1/simRate. */
export const DEFAULT_SIM_RATE = 60;

/** Default replication rate; governs the transform channel's cadence. */
export const DEFAULT_SEND_RATE = 20;

/** Consecutive throws that disable a handler — any success resets the count. */
export const BREAKER_THRESHOLD = 100;

/** Max `send` re-entry depth before the dispatcher aborts the chain. */
export const MAX_SEND_DEPTH = 64;

/** Distinct `class#method#message` keys the throw-dedup map holds before it resets. */
export const MAX_DEDUP_KEYS = 1024;

/** Handler-throw records the default log retains; older ones are dropped, not accumulated. */
export const MAX_LOG_RECORDS = 512;

/** Speech-bubble text cap; longer strings truncate rather than growing unbounded. */
export const MAX_BUBBLE_LENGTH = 200;

/** How far back a historical spatial query may reach, in milliseconds. */
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
