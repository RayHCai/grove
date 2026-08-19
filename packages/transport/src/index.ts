// The websocket backend sits behind its own `./websocket` export, so importing the interface never
// drags a socket into the module graph; the conformance suite is `./testing` for the same reason
// applied to vitest.

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
export { MAX_FRAME_BYTES, RESERVED_KEYS, jsonCodec } from './codec.js';

export type { TransportErrorCode } from './errors.js';
export { TransportError, transportError } from './errors.js';

export { loopbackPair } from './loopback.js';
