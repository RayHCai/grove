// @platform/glue/node
// The Node host: a WebSocket listener, and a store that outlives the process.
//
// Behind a subpath because this path reaches `ws` and `node:fs`, and a consumer that only wants the
// instance model should not take either.

export { listenOn } from './serve.js';
export type { ListenOptions, ServedGame } from './serve.js';

export { fileKVStore } from './kv.js';
