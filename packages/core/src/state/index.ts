export { ReplicationChannels } from './channels.js';
export type { StructuralOp, StateMark } from './channels.js';

export { createHostRecord, tagOf, tagsMatch } from './host-record.js';
export type { HostRecord, TypeTag } from './host-record.js';

export type { Immutable, MutableStateRejected } from './immutable.js';

export {
    STATE_BACKING,
    STATE_TARGET,
    STATE_MARK,
    installStateAccessor,
    authoredValue,
    redirectState,
    hasNoDataProperty,
} from './backing.js';
