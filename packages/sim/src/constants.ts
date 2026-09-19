import { MAX_REWIND_MS } from '@platform/core';
import { MAX_FRAME_BYTES } from '@platform/transport';
import { simError } from './errors.js';

/** Both sides of the tick window; the client's own lead is capped at the same span. */
export const INPUT_WINDOW_MS = MAX_REWIND_MS;

/** How long an opened session may go unjoined before it is closed, in ticks. */
export const JOIN_DEADLINE_MS = 5_000;

/** Silence before held actions are released server-side; the uplink carries edges only. */
export const HOLD_STALE_MS = 5_000;

/** Input-frame token depth, one refilled per stepped tick — the wire's one-per-tick ceiling. */
export const INPUT_BUCKET_FRAMES = 8;

/** Cumulative rate refusals on one connection before it is closed as a sustained breach. */
export const RATE_BREACH_CLOSE = 64;

/** Token depth for `join-request` and `time-sync`, which each buy an expensive reply. */
export const CONTROL_BUCKET_FRAMES = 4;

/** One control token per second, far above the ~0.5/s a healthy client spends on `TimeSync`. */
export const CONTROL_REFILL_MS = 1_000;

/** Actions one input frame may carry, so one frame cannot buy an unbounded dispatch. */
export const MAX_ACTIONS_PER_FRAME = 32;

/** Longest accepted action name — it becomes a key in core's fold and a dispatched event name. */
export const MAX_ACTION_NAME_LENGTH = 64;

/** Distinct action names one connection may name: each held one costs a `hold` per tick. */
export const MAX_ACTION_NAMES = 64;

/** Interactions one frame may carry, so a single frame cannot buy an unbounded dispatch walk. */
export const MAX_INTERACTIONS_PER_FRAME = 16;

/** Longest accepted widget or screen name — each becomes the event name of a dispatch. */
export const MAX_WIDGET_NAME_LENGTH = 64;

/** Requests one frame may carry, so a single frame cannot buy an unbounded dispatch walk. */
export const MAX_REQUESTS_PER_FRAME = 16;

/** Longest accepted request name — it becomes the event name of that dispatch. */
export const MAX_REQUEST_NAME_LENGTH = 64;

/** Values one request payload may hold, over the whole graph: it bounds nesting and count. */
export const MAX_REQUEST_PAYLOAD_NODES = 256;

/** Longest accepted display name. */
export const MAX_NAME_LENGTH = 24;

/** Longest accepted identity string — a hex digest and a panel id both sit far under this. */
export const MAX_IDENTITY_LENGTH = 128;

/** Nesting past which a `@serverState` value is dropped, far below the codec's own cap. */
export const MAX_STATE_DEPTH = 64;

/** Unjoined connections held at once, so unjoined sockets cannot lock out real players. */
export const MAX_UNJOINED_CONNECTIONS = 32;

/** Ticks past the horizon that are clamped rather than refused — a healthy client's lead. */
export const HORIZON_CLAMP_TICKS = 2;

/** Structural ops one send may carry, the rest held: the one bound on what the server makes. */
export const MAX_STRUCTURAL_OPS_PER_SEND = 2_048;

/** Bytes a server-minted frame targets, derived from transport's cap so the two cannot drift. */
export const MAX_FRAME_PAYLOAD_BYTES = Math.floor(MAX_FRAME_BYTES * 0.75);

function ticksFor(ms: number, simRate: number): number {
    return Math.max(1, Math.ceil((ms / 1000) * simRate));
}

/** The tick window's lower bound, below which a frame is `too-old`. */
export function pastGraceTicks(simRate: number): number {
    return ticksFor(INPUT_WINDOW_MS, simRate);
}

/** The window's upper bound, named apart from the past grace: how far ahead is stampable. */
export function futureHorizonTicks(simRate: number): number {
    return ticksFor(INPUT_WINDOW_MS, simRate);
}

/** Missing seqs one arrival may date; dating a gap costs one map entry per seq. */
export function maxSeqGap(simRate: number): number {
    return pastGraceTicks(simRate) + futureHorizonTicks(simRate) + HORIZON_CLAMP_TICKS;
}

/** Ticks of silence after which every held action releases and every axis returns to neutral. */
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

/** Throws unless `rate` is positive and finite — `resolveConfig` fills defaults unvalidated. */
export function assertRate(name: string, rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) {
        simError('invalid-config', `${name} must be a positive finite number, received ${rate}`);
    }
}
