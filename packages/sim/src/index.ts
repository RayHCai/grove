// The host-facing surface only: the sim, its batch seam, its error, and the isolate entry.

export { Sim } from './sim.js';
export type { ProjectIdentity, ScriptIndex, SimConfig, SimOptions } from './sim.js';

export type {
    CloseOrder,
    ConnectionId,
    InboundFrame,
    InputBatch,
    LoadOrder,
    LoadedRecord,
    LogLine,
    OpenedConnection,
    OutputBatch,
    SaveOrder,
    Send,
    SimDiagnostics,
} from './batch.js';

export { SimError } from './errors.js';
export { assertRate } from './constants.js';
export type { SimErrorCode } from './errors.js';

export { installIsolateEntry, simFromConfig } from './isolate-entry.js';
export type { EncodedBatch, EncodedSend, IsolateEntry } from './isolate-entry.js';
