// A future websocket backend goes behind its own subpath export, so importing the interface never
// drags a socket library into the module graph; the conformance suite is `./testing` for the same
// reason applied to vitest.

export const PACKAGE_NAME = '@platform/transport';

export type {
    Connect,
    ConnectOptions,
    EncodedFrame,
    Frame,
    JsonValue,
    LoopbackOptions,
    LoopbackPair,
    Message,
    TimerSource,
    Transport,
    TransportOptions,
} from './transport.js';

export type { Codec } from './codec.js';
export { MAX_FRAME_BYTES, jsonCodec } from './codec.js';

export type { TransportErrorCode } from './errors.js';
export { TransportError, transportError } from './errors.js';

export { loopbackPair } from './loopback.js';
