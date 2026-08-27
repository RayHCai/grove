// The authority's half of the script registry: every class this process can be asked to attach,
// under the id the manifest and the wire name it by.
//
// A second registry lives in the browser half, holding only what may run there — that split is
// `ScriptSide`, not a duplication: a `ServerScript` linked into a page would be authoritative code
// on the untrusted end.

import { ScriptRegistry } from '@platform/scripting';
import type { ScriptId } from '@platform/project';
import { scriptId } from '@platform/project';
import {
    SCRIPT_CLICKER,
    SCRIPT_HARVESTER,
    SCRIPT_LEAF,
    SCRIPT_PROFILE,
    SCRIPT_RULES,
    SCRIPT_RUNNER,
} from '../shared.js';
import { Runner } from '../synced/runner.js';
import { Clicker, Harvester, Leaf, Profile, Rules } from './game.js';

export const SERVER_SCRIPTS: ScriptRegistry<ScriptId> = ScriptRegistry.from<ScriptId>([
    { id: scriptId(SCRIPT_RULES), location: 'server', ctor: Rules as never },
    { id: scriptId(SCRIPT_CLICKER), location: 'server', ctor: Clicker as never },
    { id: scriptId(SCRIPT_PROFILE), location: 'server', ctor: Profile as never },
    { id: scriptId(SCRIPT_HARVESTER), location: 'server', ctor: Harvester as never },
    { id: scriptId(SCRIPT_LEAF), location: 'server', ctor: Leaf as never },
    // Synced, so it links into both sides — and it is the one class the client is ever told to
    // attach, which is what makes prediction have anything to replay.
    { id: scriptId(SCRIPT_RUNNER), location: 'synced', ctor: Runner as never },
]);
