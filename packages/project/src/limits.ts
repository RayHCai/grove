/** Levels a template subtree may nest; a child names a template, so the bound is on the graph. */
export const MAX_TEMPLATE_DEPTH = 8;

/** Object keys a `props` map may not carry, because they poison a downstream recursive merge. */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
    '__proto__',
    'constructor',
    'prototype',
]);
