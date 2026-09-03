// @platform/glue
// The composition of one game: an authored project in, a running world and the sessions that reach
// it out.
//
// This barrel holds only what BOTH halves name, and no values at all. The halves are behind
// `@platform/glue/server` and `@platform/glue/client`, because one reaches `ws` and `node:fs` and
// the other reaches a renderer — and a consumer of either should take neither the other's
// dependencies nor its module graph.

// The code every peer must be running, and where a joiner fetches it. The server declares it; the
// client verifies what it fetched against it, which is why it is named on both sides.
export type { BundleRef } from '@platform/engine/host';
