// @platform/server — the authority: it owns the true world, steps it on a real-time accumulator,
// admits and buffers client input, and broadcasts the resulting state diffs to every client.
//
// It sits above the transport (which moves opaque frames) and above core (which owns simulation but no
// clock and no network) — the seam between them, where core's replication-sink obligation is met and a
// Transport per player is held. The envelope types are not here: they live in @platform/protocol, so
// the bytes this writes are the bytes the client reads.

export const PACKAGE_NAME = '@platform/server';

export { GameServer } from './server.js';
export type { GameServerOptions, ProjectIdentity, ServerConfig } from './server.js';

export { AdmissionState, Connection } from './connection.js';
export type { AckReport, RefusalReason } from './connection.js';

export { InputBuffer, runInputPass } from './input.js';
export type { AdmitResult, BufferedInput, InputPassContext } from './input.js';

export { Driver } from './driver.js';
export type { DriverHooks, DriverOptions, PumpResult } from './driver.js';

export {
    broadcastTo,
    drainOnce,
    encodeStateValue,
    readEntitySnapshot,
    readPlayerSnapshot,
    readTransform,
    send,
    toNetId,
} from './broadcast.js';
export type { RosterOps, SendSet } from './broadcast.js';

export { ancestorsFirst, buildSnapshot } from './snapshot.js';

export { ManifestStore } from './manifest.js';

export {
    CONTROL_BUCKET_FRAMES,
    CONTROL_REFILL_MS,
    HOLD_STALE_MS,
    HORIZON_CLAMP_TICKS,
    INPUT_BUCKET_FRAMES,
    INPUT_WINDOW_MS,
    JOIN_DEADLINE_MS,
    MAX_ACTIONS_PER_FRAME,
    MAX_ACTION_NAMES,
    MAX_ACTION_NAME_LENGTH,
    MAX_CATCHUP_MS,
    MAX_NAME_LENGTH,
    MAX_STATE_DEPTH,
    MAX_UNJOINED_CONNECTIONS,
    RATE_BREACH_CLOSE,
    controlRefillTicks,
    futureHorizonTicks,
    holdStaleTicks,
    maxSeqGap,
    maxStepsPerWake,
    pastGraceTicks,
    ticksPerSend,
} from './constants.js';
