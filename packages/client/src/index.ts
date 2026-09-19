export { GameClient } from './client.js';
export type { ClientStats, GameClientOptions } from './client.js';

export { ClientHUDSink } from './hud-sink.js';
export type { HUDWidgetView } from './hud-sink.js';

export { ManualFrameSource, ScriptedInputDevice } from './input.js';
export type { EmittingInputDevice, FrameSource, InputDevice, RawInputEvent } from './input.js';

// The seams a host supplies to `GameClientOptions`.
export type { Binding } from './bindings.js';
export type { BundleSource } from './bundle.js';
export type { ClientProject, ClockSource } from './handshake.js';
export type { ScriptClass, ScriptIndex } from './mirror.js';

// What `GameClient`'s own members are typed as, so a host can name what it holds.
export type { FailureReason, Lifecycle, SessionState } from './lifecycle.js';
export type { Mirror, MirrorCounters, MirrorDelta, MirrorReparent, MirrorView } from './mirror.js';
export type { MirrorIndex } from './index-map.js';
export type { Prediction, PredictionCounters } from './prediction.js';
export type { InputRing, RingEntry } from './ring.js';
