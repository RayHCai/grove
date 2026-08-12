// Engine constants, not creator knobs. Network durations are stated in milliseconds and converted
// per simRate, because a tick is 16.7 ms at 60 Hz and 50 ms at 20 Hz — a tick count sized for one
// rate is the wrong wall-clock window at the other, in the checks that decide whether input counts.

import { MAX_REWIND_MS } from '@platform/core';

/** Both sides of the tick window: a frame older than the rewind limit is unusable, and the client's own lead is capped at the same span. */
export const INPUT_WINDOW_MS = MAX_REWIND_MS;

/** Silence an accepted connection may hold before it is closed still unjoined. */
export const JOIN_DEADLINE_MS = 5_000;

/** Silence before held actions are released server-side, above the client's 2 s `TimeSync` refresh because the uplink carries edges only. */
export const HOLD_STALE_MS = 5_000;

/** Wall-clock one wake may catch up before it sheds, sized so a backgrounded tab drains without shedding. */
export const MAX_CATCHUP_MS = 250;

/** Input-frame token depth, one refilled per stepped tick — the wire's own one-per-tick ceiling, with slack for a multi-tick wake's burst. */
export const INPUT_BUCKET_FRAMES = 8;

/** Cumulative rate refusals on one connection before it is closed as a sustained breach. */
export const RATE_BREACH_CLOSE = 64;

/** Token depth for `join-request` and `time-sync`, which the input bucket does not cover and which each buy an expensive reply. */
export const CONTROL_BUCKET_FRAMES = 4;

/** One control token per second, far above the ~0.5/s a healthy client spends on `TimeSync`. */
export const CONTROL_REFILL_MS = 1_000;

/** Actions one input frame may carry, so a single frame cannot buy an unbounded fold-and-dispatch. */
export const MAX_ACTIONS_PER_FRAME = 32;

/** Longest accepted action name — it becomes a key in core's fold and a dispatched event name. */
export const MAX_ACTION_NAME_LENGTH = 64;

/** Distinct action names one connection may name: each one held costs a `hold` dispatch every tick until it is released. */
export const MAX_ACTION_NAMES = 64;

/** Longest accepted display name. */
export const MAX_NAME_LENGTH = 24;

/** Nesting past which a `@serverState` value is dropped, held far below the codec's own 128-level cap because a value `encode` refuses aborts the send for every connection. */
export const MAX_STATE_DEPTH = 64;

/** Unjoined connections held at once, distinct from `maxPlayers` so unjoined sockets cannot lock out real players. */
export const MAX_UNJOINED_CONNECTIONS = 32;

/** Ticks past the horizon that are clamped rather than refused — a healthy client at its deliberate lead, one tick of jitter early. */
export const HORIZON_CLAMP_TICKS = 2;

function ticksFor(ms: number, simRate: number): number {
    return Math.max(1, Math.ceil((ms / 1000) * simRate));
}

/** The tick window's lower bound, below which a frame is `too-old`. */
export function pastGraceTicks(simRate: number): number {
    return ticksFor(INPUT_WINDOW_MS, simRate);
}

/** The window's upper bound, named apart from the equal past grace because the two answer how late a frame is still taken and how far ahead one may be stamped. */
export function futureHorizonTicks(simRate: number): number {
    return ticksFor(INPUT_WINDOW_MS, simRate);
}

/**
 * Missing seqs one arrival may date, and how far above what has arrived a `seq` may reach.
 *
 * The window rather than a round number: seq and tick advance together, so a seq further ahead than the
 * window is wide names a tick that can never be applied, and dating a gap costs one map entry per seq.
 */
export function maxSeqGap(simRate: number): number {
    return pastGraceTicks(simRate) + futureHorizonTicks(simRate) + HORIZON_CLAMP_TICKS;
}

/** Ticks of silence after which every held action is released and every axis returned to neutral. */
export function holdStaleTicks(simRate: number): number {
    return ticksFor(HOLD_STALE_MS, simRate);
}

/** Ticks between control-bucket refills. */
export function controlRefillTicks(simRate: number): number {
    return ticksFor(CONTROL_REFILL_MS, simRate);
}

/** Ticks one wake may step before it sheds the rest as wall-clock. */
export function maxStepsPerWake(simRate: number): number {
    return ticksFor(MAX_CATCHUP_MS, simRate);
}

/** Ticks between broadcasts, never below one. */
export function ticksPerSend(simRate: number, sendRate: number): number {
    if (!(sendRate > 0)) return 1;
    return Math.max(1, Math.round(simRate / sendRate));
}

/**
 * Throws unless `rate` is a positive finite number.
 *
 * `resolveConfig` fills defaults without validating, and a `simRate` of 0 makes `dt` infinite: the
 * accumulator never reaches it, so the server steps zero times forever with nothing reporting it.
 */
export function assertRate(name: string, rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) {
        throw new RangeError(`${name} must be a positive finite number, received ${rate}`);
    }
}
