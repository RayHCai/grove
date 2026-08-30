// @platform/glue
// The composition of one game instance: an authored project in, a running world out.
//
// This barrel opens no socket and reads no file; the Node host is behind `@platform/glue/node`, so
// a consumer takes the instance model without taking a server runtime's dependencies with it.

export { GameInstance } from './instance.js';
export type { BundleRef, InstanceOptions } from './instance.js';
