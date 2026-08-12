// Engine constants, not creator knobs. Each states its unit, because mixing them is the failure mode:
// a tick is 16.7 ms at 60 Hz and 50 ms at 20 Hz, so a constant read in the wrong unit means triple the
// input delay on a 20 Hz project for a reason nobody would look for in a rate setting.

/** Ticks of headroom the lead loop holds the earliest input at: one absorbs jitter, one a dropped send. */
export const HEADROOM_TARGET = 2;

/** Ticks. Loopback's floor is structurally one tick, whatever a tick is worth. */
export const LEAD_MIN_TICKS = 1;

/** Seconds. Past core's `MAX_REWIND_MS` the input is unusable anyway, so the lead stops here. */
export const LEAD_MAX_SECONDS = 0.25;

/** Seconds between `TimeSync` refreshes. Diagnostic once the lead is seeded. */
export const SYNC_INTERVAL_SECONDS = 2;

/** Seconds. Integrating a backgrounded tab's multi-second `dt` would teleport the world. */
export const MAX_FRAME_DT = 0.1;

/** Seconds of silence that raise `stalled`. */
export const STALL_SECONDS = 1;

/**
 * The lead loop's proportional gain, dimensionless.
 *
 * Safe because of `effectiveHeadroom`, not because 0.25 is small: the loop's dominant lag is nudge
 * delivery, not the round trip. `GAIN`, `NUDGE_MAX` and `sendRate` are one system — changing any means
 * re-deriving this.
 */
export const GAIN = 0.25;

/** Fraction the tick duration may be scaled by to deliver a lead correction. 2% is imperceptible. */
export const NUDGE_MAX = 0.02;

/**
 * Axis deadzone as a fraction of full deflection — a stick's -1..1, so 1/64 of the range.
 *
 * A cursor has no full deflection, so the cursor axes quantize against this fraction of the viewport
 * extent instead: the same on-screen movement then costs the same number of frames at any zoom.
 */
export const AXIS_QUANTUM = 1 / 64;

/** Ticks of the session's own rate that `ackSeq` may stand still before `stalled`. */
export const ACK_STALL_TICKS = 60;

/** Ring capacity in frames, one per tick. Bounded by `LEAD_MAX` plus core's `MAX_REWIND_MS`. */
export const RING_TICKS = 48;

/** The viewport the cursor quantum falls back to before the first `Welcome`, in world units. */
export const DEFAULT_VIEWPORT = { width: 800, height: 600 } as const;

/**
 * Cardinality cap on any single array a server sends, applied before the client walks it.
 *
 * A sanity bound rather than a game rule: the client trusts a server for correctness but must not
 * let one frame buy unbounded work, and nothing below applies a cap of its own. Sized far above any
 * real world so it never bites legitimate traffic — a frame that exceeds it is a broken or hostile
 * peer, and the join or the envelope is refused rather than half-applied.
 */
export const MAX_WIRE_ITEMS = 65_536;
