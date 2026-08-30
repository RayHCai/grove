// The authority's half of the script registry: every class in `scripts/` this process may be asked
// to attach, under the id the project file and the wire name it by.
//
// This is the seam between the game and the engine. `scripts/` knows nothing about registries,
// manifests or transports; the ids are the only thing the two sides share, and they come from the
// game's own globals rather than from `klass.name` — a minifier rewrites that, and the wire carries
// it across a process boundary where a name is no contract.
//
// A second registry lives in the browser half holding only what may run there. That split is
// `ScriptSide`, not a duplication: a `ServerScript` linked into a page would be authoritative code
// on the untrusted end.

import type { ScriptId } from '@platform/project';
import { scriptId } from '@platform/project';
import { ScriptRegistry } from '@platform/scripting';
import {
    SCRIPT_CLICKER,
    SCRIPT_HARVESTER,
    SCRIPT_LEAF,
    SCRIPT_PROFILE,
    SCRIPT_RULES,
    SCRIPT_RUNNER,
} from '../scripts/globals.js';
import { Rules } from '../scripts/game/rules.js';
import { Clicker } from '../scripts/players/clicker.js';
import { Profile } from '../scripts/players/profile.js';
import { Harvester } from '../scripts/templates/avatar/harvester.js';
import { Runner } from '../scripts/templates/avatar/runner.js';
import { Leaf } from '../scripts/templates/leaf/leaf.js';

export const SERVER_SCRIPTS: ScriptRegistry<ScriptId> = ScriptRegistry.from<ScriptId>([
    { id: scriptId(SCRIPT_RULES), location: 'server', ctor: Rules },
    { id: scriptId(SCRIPT_CLICKER), location: 'server', ctor: Clicker },
    { id: scriptId(SCRIPT_PROFILE), location: 'server', ctor: Profile },
    { id: scriptId(SCRIPT_HARVESTER), location: 'server', ctor: Harvester },
    { id: scriptId(SCRIPT_LEAF), location: 'server', ctor: Leaf },
    // Synced, so it links into both sides — and it is the one class the client is ever told to
    // attach, which is what makes prediction have anything to replay.
    { id: scriptId(SCRIPT_RUNNER), location: 'synced', ctor: Runner },
]);
