// This barrel holds only what BOTH halves name, and no values. The halves sit behind
// `@platform/glue/server` and `@platform/glue/client`, whose dependencies must not mix.

// The code every peer must be running, and where a joiner fetches it. The server declares it; the
// client verifies what it fetched against it, which is why it is named on both sides.
export type { BundleRef } from '@platform/engine/host';
