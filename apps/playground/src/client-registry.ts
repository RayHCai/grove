// The browser's half of the script registry: what this page may be told to attach.
//
// It holds `Runner` and nothing else, because that is the only class linked for this side — the
// rest are `ServerScript`s, and a page that held them would be holding authoritative code on the
// untrusted end. An `attach` op naming one of those resolves to nothing here and is counted as a
// dropped attachment: the mirror skips an id it knows to be server-located, and a client chunk
// holds no server class to know it by. The authority runs them either way.

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
