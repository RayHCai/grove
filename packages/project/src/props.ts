// Kept apart from the manifest shape because three layers hold the same constraint: a project file
// saves these, an envelope carries them, and a constructor receives them.

import type { JsonValue } from '@platform/transport';

/** What an inspector configured one script attachment with; `JsonValue` because it is saved. */
export type ScriptProps = { [key: string]: JsonValue };
