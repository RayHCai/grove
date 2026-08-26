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

/**
 * Ticks one replay may simulate before it stops re-running history and starts at the cap instead.
 *
 * The lead is clamped, so an honest replay is a handful of ticks; a span past the ring is a client
 * that has been away, and re-running it costs a frame that is already late.
 */
export const MAX_REPLAY_TICKS = RING_TICKS;

/** Seconds a display correction eases over. Longer reads as drag, shorter reads as the snap it replaces. */
export const CORRECTION_SMOOTH_SECONDS = 0.1;

/**
 * Seconds the render path may draw behind the newest transform, whatever `Welcome.sendRate` claims.
 *
 * The delay itself is one send interval — the shortest that keeps a sample on each side of the drawn
 * moment, and every millisecond past it is latency on everything the local player does not own. The cap
 * exists because the interval is the server's to choose: a `sendRate` of 0.01 would otherwise draw a
 * world a minute and a half stale. 0.1 s is the slowest rate a panel offers, so it never bites a real
 * session.
 */
export const MAX_INTERPOLATION_DELAY_SECONDS = 0.1;

/**
 * World units, squared — the distance past which a correction is shown at once.
 *
 * Squared because the comparison is the only thing that needs it, and a square root here would be one
 * of the transcendentals the determinism rule keeps out of this package.
 */
export const CORRECTION_SNAP_DISTANCE_SQUARED = 64 * 64;

/** The viewport the cursor quantum falls back to before the first `Welcome`, in world units. */
export const DEFAULT_VIEWPORT = { width: 800, height: 600 } as const;

/**
 * Bytes of script bundle this client will hash and evaluate.
 *
 * The length is peer-chosen and both the digest and the parse behind it are linear in it, so it is
 * bounded like every other peer-sized quantity — far above any real bundle, so it never bites one.
 */
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

/**
 * Seconds the session may sit pre-`live` waiting for the bundle before it fails.
 *
 * It bounds the held inbox as much as the wait: the server broadcasts from the moment it sends the
 * `Welcome`, and every envelope arriving during the fetch is held rather than dropped.
 */
export const BUNDLE_DEADLINE_SECONDS = 30;

/**
 * Cardinality cap on any single array a server sends, applied before the client walks it.
 *
 * A sanity bound rather than a game rule: the client trusts a server for correctness but must not
 * let one frame buy unbounded work, and nothing below applies a cap of its own. Sized far above any
 * real world so it never bites legitimate traffic — a frame that exceeds it is a broken or hostile
 * peer, and the join or the envelope is refused rather than half-applied.
 */
export const MAX_WIRE_ITEMS = 65_536;

/**
 * Levels of `children` below a template's root the client will build, and nodes in one such subtree.
 *
 * A child list is the one recursive shape on the wire, so `MAX_WIRE_ITEMS` bounds nothing on its own:
 * a peer choosing the cap at every level spends it to the power of the depth. These two are what make
 * the work linear again, and they are small rather than generous because they bound ART — a template
 * needing more than this is authored as several entities, which the simulation already bounds.
 */
export const MAX_TEMPLATE_DEPTH = 8;
export const MAX_TEMPLATE_NODES = 64;
