// Engine constants, not creator knobs. Each states its unit — mixing units is the failure mode.

import { MAX_REWIND_MS } from '@platform/core';

/** Ticks of headroom the lead loop holds the earliest input at; one absorbs jitter, one a drop. */
export const HEADROOM_TARGET = 2;

/** Ticks. Loopback's floor is structurally one tick, whatever a tick is worth. */
export const LEAD_MIN_TICKS = 1;

/** Seconds. Past core's `MAX_REWIND_MS` the input is unusable anyway, so the lead stops here. */
export const LEAD_MAX_SECONDS = MAX_REWIND_MS / 1000;

/** Seconds between `TimeSync` refreshes. Diagnostic once the lead is seeded. */
export const SYNC_INTERVAL_SECONDS = 2;

/** Seconds. Integrating a backgrounded tab's multi-second `dt` would teleport the world. */
export const MAX_FRAME_DT = 0.1;

/** Seconds of silence that raise `stalled`. */
export const STALL_SECONDS = 1;

/** The lead loop's proportional gain, dimensionless. One system with `NUDGE_MAX` and `sendRate`. */
export const GAIN = 0.25;

/** Fraction the tick duration may be scaled by to correct the lead. 2% is imperceptible. */
export const NUDGE_MAX = 0.02;

/** Axis deadzone as a fraction of full deflection; cursor axes quantize against viewport extent. */
export const AXIS_QUANTUM = 1 / 64;

/** Ticks of the session's own rate that `ackSeq` may stand still before `stalled`. */
export const ACK_STALL_TICKS = 60;

/** Ring capacity in frames, one per tick. A literal with headroom — ticks per second vary. */
export const RING_TICKS = 48;

/** Ticks one replay may simulate before it starts at the cap instead. */
export const MAX_REPLAY_TICKS = RING_TICKS;

/** Seconds a display correction eases over; longer reads as drag, shorter as a snap. */
export const CORRECTION_SMOOTH_SECONDS = 0.1;

/** Seconds the render path may draw behind the newest transform, capping a server-chosen rate. */
export const MAX_INTERPOLATION_DELAY_SECONDS = 0.1;

/** World units squared; the distance past which a correction snaps. Squared to avoid `sqrt`. */
export const CORRECTION_SNAP_DISTANCE_SQUARED = 64 * 64;

/** The viewport the cursor quantum falls back to before the first `Welcome`, in world units. */
export const DEFAULT_VIEWPORT = { width: 800, height: 600 } as const;

/** Bytes of script bundle this client will hash and evaluate. */
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

/** Seconds the session may wait for the bundle before failing; also bounds the held inbox. */
export const BUNDLE_DEADLINE_SECONDS = 30;

/** Seconds in `connecting` or `resyncing` before the join fails; longer than the server's. */
export const JOIN_DEADLINE_SECONDS = 10;

/** Nesting past which a `request()` payload value is dropped; held below the codec's own cap. */
export const MAX_REQUEST_DEPTH = 64;

/** Requests one frame may carry, the rest held; the receiver refuses an over-cap frame whole. */
export const MAX_REQUESTS_PER_FRAME = 16;

/** Cardinality cap on any array a server sends, so one frame cannot buy unbounded work. */
export const MAX_WIRE_ITEMS = 65_536;

/** Scripts one entity's spawn snapshot may carry; each mints a session-lived instance. */
export const MAX_ENTITY_SCRIPTS = 64;

/** Cap on `snapshot-chunk` frames one join may span; chunks are held before validation. */
export const MAX_SNAPSHOT_CHUNKS = 256;

/** Bytes of held `snapshot-chunk` payload; caps size where `MAX_SNAPSHOT_CHUNKS` caps count. */
export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;

/** Depth and node count of a template subtree; a recursive shape needs both to stay linear. */
export const MAX_TEMPLATE_DEPTH = 8;
export const MAX_TEMPLATE_NODES = 64;
