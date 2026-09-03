// @platform/glue/client
// The viewer's half: one composed session, and a WebSocket to reach an authority with.
//
// Behind a subpath because its peer, `@platform/glue/server`, reaches `ws` and `node:fs`. This one
// reaches a renderer and a socket and nothing of Node's, so it is the half a browser bundle takes.

export { ClientInstance } from './instance.js';
export type { ClientInstanceOptions } from './instance.js';

export { connectTo } from './connect.js';
export type { ConnectOptions } from './connect.js';

// The two seams a headless host injects in place of a rAF loop and a real device. Values, and the
// only ones re-exported here: a Node host composing a session needs them and has no DOM adapter to
// reach for.
export { ManualFrameSource, ScriptedInputDevice } from '@platform/client';

// What a host names to hold a session's own members, re-exported so composing one needs one import.
// Types only: the values `@platform/client` holds are the session itself, which `ClientInstance`
// composes, and the DOM adapters, which stay behind `@platform/client/browser` — a session model
// that dragged a `window` reference into its graph could not be built in Node.
export type {
    Binding,
    ClientHUDSink,
    ClientStats,
    EmittingInputDevice,
    FailureReason,
    FrameSource,
    GameClient,
    HUDWidgetView,
    InputDevice,
    RawInputEvent,
    SessionState,
} from '@platform/client';
