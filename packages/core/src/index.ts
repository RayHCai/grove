// @platform/core
// Entities, world, behaviors, decorators, dispatcher. No rendering, no network.

export const PACKAGE_NAME = '@platform/core';

// ─── foundation ──────────────────────────────────────────────────────────────────
export * from './config.js';
export * from './errors.js';
export * from './ids.js';

// ─── loop / snapshot ─────────────────────────────────────────────────────────────
export * from './loop/store-registry.js';

// ─── world ───────────────────────────────────────────────────────────────────────
export * from './world/index.js';

// ─── script model ────────────────────────────────────────────────────────────────
export * from './script/index.js';

// ─── dispatch ────────────────────────────────────────────────────────────────────
export * from './dispatch/index.js';

// ─── runtime ─────────────────────────────────────────────────────────────────────
export * from './runtime/index.js';
