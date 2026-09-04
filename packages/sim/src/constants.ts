import { MAX_REWIND_MS } from '@platform/core';
import { MAX_FRAME_BYTES } from '@platform/transport';
import { simError } from './errors.js';

/** Both sides of the tick window: a frame older than the rewind limit is unusable, and the client's own lead is capped at the same span. */
export const INPUT_WINDOW_MS = MAX_REWIND_MS;

/** Silence an opened session may hold before it is closed still unjoined, converted to ticks like every other window here. */
export const JOIN_DEADLINE_MS = 5_000;

/** Silence before held actions are released server-side, above the client's 2 s `TimeSync` refresh because the uplink carries edges only. */
export const HOLD_STALE_MS = 5_000;

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

/** Interactions one frame may carry, so a single frame cannot buy an unbounded dispatch walk. */
export const MAX_INTERACTIONS_PER_FRAME = 16;

/** Longest accepted widget or screen name — each becomes the event name of a dispatch. */
export const MAX_WIDGET_NAME_LENGTH = 64;

/** Requests one frame may carry, so a single frame cannot buy an unbounded dispatch walk. */
export const MAX_REQUESTS_PER_FRAME = 16;

/** Longest accepted request name — it becomes the event name of that dispatch. */
export const MAX_REQUEST_NAME_LENGTH = 64;

/** Values one request payload may hold, counted over the whole graph: it bounds nesting and cardinality together, since depth can never exceed the node count. */
export const MAX_REQUEST_PAYLOAD_NODES = 256;

/** Longest accepted display name. */
export const MAX_NAME_LENGTH = 24;

/** Longest accepted identity string — a hex digest and a panel-minted id both sit far under this. */
export const MAX_IDENTITY_LENGTH = 128;

/** Nesting past which a `@serverState` value is dropped, held far below the codec's own 128-level cap because a value `encode` refuses aborts the send for every connection. */
export const MAX_STATE_DEPTH = 64;

/** Unjoined connections held at once, distinct from `maxPlayers` so unjoined sockets cannot lock out real players. */
export const MAX_UNJOINED_CONNECTIONS = 32;

/** Ticks past the horizon that are clamped rather than refused — a healthy client at its deliberate lead, one tick of jitter early. */
export const HORIZON_CLAMP_TICKS = 2;

/** Structural ops one send may carry, the rest held for the next: the one bound on what the server produces. */
export const MAX_STRUCTURAL_OPS_PER_SEND = 2_048;

/** Bytes a server-minted frame targets — derived from transport's own cap rather than chosen, so the two cannot drift. */
export const MAX_FRAME_PAYLOAD_BYTES = Math.floor(MAX_FRAME_BYTES * 0.75);

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

/** Missing seqs one arrival may date: the window rather than a round number, since dating a gap costs one map entry per seq. */
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

/** Ticks of silence after which an unjoined session is closed. */
export function joinDeadlineTicks(simRate: number): number {
    return ticksFor(JOIN_DEADLINE_MS, simRate);
}

/** Throws unless `rate` is a positive finite number — `resolveConfig` fills defaults without validating. */
export function assertRate(name: string, rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) {
        simError('invalid-config', `${name} must be a positive finite number, received ${rate}`);
    }
}
