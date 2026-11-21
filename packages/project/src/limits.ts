/** Levels a template subtree may nest; a child names a template, so the bound is on the graph. */
export const MAX_TEMPLATE_DEPTH = 8;

/** The speech-bubble tag prefix; a creator tag under it would reach snapshots but no delta. */
export const RESERVED_TAG_PREFIX = 'say:';

/** Object keys a `props` map may not carry, because they poison a downstream recursive merge. */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
    '__proto__',
    'constructor',
    'prototype',
]);
