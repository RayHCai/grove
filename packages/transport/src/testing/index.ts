// Behind its own subpath so importing the transport never pulls vitest into a consumer's graph.

export type { CodecContractOptions } from './codec-contract.js';
export { runCodecContract } from './codec-contract.js';
