// The one declaration of what an inspector may configure a script with, kept apart from the manifest
// shape because three layers hold the same constraint: a project file saves these, an envelope
// carries them, and a constructor receives them.

import type { JsonValue } from '@platform/transport';

/**
 * What an inspector configured one script attachment with.
 *
 * `JsonValue`-constrained because it is saved: a function, a class or an entity reference has no
 * spelling in a project file, and the same map later crosses a wire that carries no more than JSON.
 */
export type ScriptProps = { [key: string]: JsonValue };
