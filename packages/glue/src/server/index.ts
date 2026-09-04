// @platform/glue/server
// The authority's half: a booted world, a WebSocket listener to put in front of it, and a store
// that outlives the process.
//
// Behind a subpath because this path reaches `ws` and `node:fs`. Its peer is
// `@platform/glue/client`, and the two never meet — a browser takes the client half without taking
// a Node runtime's dependencies with it.

export { GameInstance } from './instance.js';
export type { InstanceOptions } from './instance.js';

export { Driver, HostError, MAX_CATCHUP_MS, maxStepsPerWake, ticksPerSend } from './driver.js';
export type { DriverHooks, DriverOptions, HostErrorCode, PumpResult } from './driver.js';

export { listenOn } from './serve.js';
export type { ListenOptions, ServedGame } from './serve.js';

export { fileKVStore } from './kv.js';
