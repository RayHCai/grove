// The browser's half of the script registry: what this page may be told to attach.
//
// It holds `Runner` and nothing else, because that is the only class linked for this side — `Rules`
// and `Clicker` are `ServerScript`s, and a page that held them would be holding authoritative code
// on the untrusted end. An `attach` op naming either is skipped by the mirror rather than counted:
// the authority runs them, and a client tick filters them out of every dispatch.

import type { ScriptId } from '@platform/project';
import { scriptId } from '@platform/project';
import { ScriptRegistry } from '@platform/scripting';
import { SCRIPT_RUNNER } from './shared';
// The LOWERED copy: `Runner` carries decorators, and Vite's transform would hand them to the browser
// verbatim. `tsc -p tsconfig.server.json` emits this, which is why `dev` runs it first.
import { Runner } from '../dist/synced/runner.js';

export const CLIENT_SCRIPTS: ScriptRegistry<ScriptId> = ScriptRegistry.from<ScriptId>([
    { id: scriptId(SCRIPT_RUNNER), location: 'synced', ctor: Runner as never },
]);
