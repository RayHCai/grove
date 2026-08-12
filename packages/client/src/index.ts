// @platform/client
// The viewer: one Transport to the server, a script-less mirror of the authoritative world, device input
// stamped with a tick, and the display loop that pushes transforms into IRenderer.
//
// The DOM adapters are not here. `createRafFrameSource` and `createDomInputDevice` live behind
// `@platform/client/browser`, so importing the session and its seams does not pull a DOM adapter into the
// module graph. A Node test imports this barrel and injects scripted seams.
//
// It never imports @platform/server. The two agree through @platform/protocol and nowhere else.

export const PACKAGE_NAME = '@platform/client';

export { GameClient, netId } from './client.js';
export type { ClientStats, GameClientOptions } from './client.js';

export { ManualFrameSource, ScriptedInputDevice } from './input.js';
export type { EmittingInputDevice, FrameSource, InputDevice, RawInputEvent } from './input.js';
export type { ClockSource } from './handshake.js';

export { Mirror, wireBounds } from './mirror.js';
export type {
    MirrorCounters,
    MirrorDelta,
    MirrorOptions,
    MirrorReparent,
    MirrorView,
} from './mirror.js';
export { MirrorIndex } from './index-map.js';

export { ClientClock, clampLead } from './clock.js';
export type { HeadroomSample } from './clock.js';

export { BindingTable } from './bindings.js';
export type { Binding, ResolvedEdge, ViewportExtent } from './bindings.js';
export { InputRing } from './ring.js';
export type { RingEntry } from './ring.js';

export { RenderBridge } from './bridge.js';

export { Lifecycle, acceptsInput, isTerminal } from './lifecycle.js';
export type { FailureReason, SessionState } from './lifecycle.js';

export {
    asServerEnvelope,
    isUsableWelcome,
    joinRequest,
    rejectMessage,
    rttSeconds,
    send,
    timeSync,
} from './handshake.js';

export {
    ACK_STALL_TICKS,
    AXIS_QUANTUM,
    DEFAULT_VIEWPORT,
    GAIN,
    HEADROOM_TARGET,
    LEAD_MAX_SECONDS,
    LEAD_MIN_TICKS,
    MAX_FRAME_DT,
    NUDGE_MAX,
    RING_TICKS,
    STALL_SECONDS,
    SYNC_INTERVAL_SECONDS,
} from './constants.js';
