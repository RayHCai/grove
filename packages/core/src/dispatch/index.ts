export { ScopeTree } from './scope-tree.js';
export type { ScopeId, InvocationScope, GuardOwner } from './scope-tree.js';

export { BreakerCounters } from './breaker.js';
export type { BreakerBuffer } from './breaker.js';

export { currentInvocation, setCurrentInvocation, resumeWith } from './ambient.js';

export { InstanceRegistry, makeInstance, locationOf } from './instances.js';
export type { ScriptInstance } from './instances.js';

export { Dispatcher } from './dispatcher.js';
export type { DispatchCtx, DispatchLog, DispatchOptions, GuardSite } from './dispatcher.js';
