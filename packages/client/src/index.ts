// @platform/client
// The viewer: one Transport to the server, a script-less mirror of the authoritative world, device input
// stamped with a tick, and the display loop that pushes transforms into IRenderer.
//
// The DOM adapters are not here. `createRafFrameSource` and `createDomInputDevice` live behind
// `@platform/client/browser`, so importing the session and its seams does not pull a DOM adapter into the
// module graph. A Node test imports this barrel and injects scripted seams.
//
// A host builds a `GameClient` and implements the seams below; the collaborators it composes — the mirror,
// the clock, the ring, the bridge, the handshake builders, the tuning constants — are named here only as
// TYPES, so nothing outside can mint a second one or reach past `GameClient` to drive it. This package's
// own tests import `./src/*.js` directly for the same reason: they are inside the boundary.
//
// It never imports @platform/sim. The two agree through @platform/protocol and nowhere else.

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
