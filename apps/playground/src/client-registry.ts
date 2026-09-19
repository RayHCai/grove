// Holds `Runner` and nothing else: the rest are `ServerScript`s, and a page holding them would
// hold authoritative code on the untrusted end. An `attach` naming one is counted as dropped.

import type { ScriptId } from '@platform/project';
import { scriptId } from '@platform/project';
import { ScriptRegistry } from '@platform/scripting';
import { SCRIPT_RUNNER } from './scripts/globals';
// The LOWERED copy: every script carries decorators, and Vite's transform would hand them to the
// browser verbatim. `tsc -p tsconfig.server.json` emits this, which is why `dev` runs it first.
import { Runner } from '../dist/scripts/templates/avatar/runner.js';

export const CLIENT_SCRIPTS: ScriptRegistry<ScriptId> = ScriptRegistry.from<ScriptId>([
    { id: scriptId(SCRIPT_RUNNER), location: 'synced', ctor: Runner },
]);
