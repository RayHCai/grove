// The world itself, and nothing that listens for anyone: this path reaches neither `ws` nor
// `node:fs`, which is what lets a browser hold an authority of its own.
//
// Its peer `@platform/glue/server` is this plus the socket and the file store — a deployed host
// wants all three, and an editor previewing a game wants only what is here.

export { GameInstance } from '../server/instance.js';
export type { InstanceOptions } from '../server/instance.js';

export {
    Driver,
    HostError,
    MAX_CATCHUP_MS,
    maxStepsPerWake,
    ticksPerSend,
} from '../server/driver.js';
export type { DriverHooks, DriverOptions, HostErrorCode, PumpResult } from '../server/driver.js';
