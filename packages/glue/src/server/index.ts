// Behind a subpath because this path reaches `ws` and `node:fs`; its peer is the client half.
//
// The world itself reaches neither, and is re-exported from here rather than declared here: a
// browser holding an authority of its own takes `@platform/glue/world` and drags no Node runtime
// in with it, while a deployed host takes this and gets the same values plus what listens.

export {
    Driver,
    GameInstance,
    HostError,
    MAX_CATCHUP_MS,
    maxStepsPerWake,
    ticksPerSend,
} from '../world/index.js';
export type {
    DriverHooks,
    DriverOptions,
    HostErrorCode,
    InstanceOptions,
    PumpResult,
} from '../world/index.js';

export { listenOn } from './serve.js';
export type { ListenOptions, ServedGame } from './serve.js';

export { fileKVStore } from './kv.js';
