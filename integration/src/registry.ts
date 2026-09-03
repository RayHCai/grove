// The two halves of the script registry, in one file because one process here is both ends.
//
// The split is real even so: `CLIENT_SCRIPTS` holds the synced class and nothing else, because a
// `ServerScript` linked into a page would be authoritative code on the untrusted end. An `attach`
// op naming one of those resolves to nothing there and is counted as a dropped attachment.

import type { ScriptId } from '@platform/project';
import { scriptId } from '@platform/project';
import { ScriptRegistry } from '@platform/scripting';
import {
    SCRIPT_COLLECTOR,
    SCRIPT_LEDGER,
    SCRIPT_MOVER,
    SCRIPT_ORB,
    SCRIPT_PROFILE,
    SCRIPT_RULES,
} from './globals.js';
import { Collector } from './scripts/collector.js';
import { Ledger } from './scripts/ledger.js';
import { Mover } from './scripts/mover.js';
import { Orb } from './scripts/orb.js';
import { Profile } from './scripts/profile.js';
import { Rules } from './scripts/rules.js';

export const SERVER_SCRIPTS: ScriptRegistry<ScriptId> = ScriptRegistry.from<ScriptId>([
    { id: scriptId(SCRIPT_RULES), location: 'server', ctor: Rules },
    { id: scriptId(SCRIPT_LEDGER), location: 'server', ctor: Ledger },
    { id: scriptId(SCRIPT_PROFILE), location: 'server', ctor: Profile },
    { id: scriptId(SCRIPT_COLLECTOR), location: 'server', ctor: Collector },
    { id: scriptId(SCRIPT_ORB), location: 'server', ctor: Orb },
    // Synced, so it links into both sides — and it is the one class the client is ever told to
    // attach, which is what makes prediction have anything to replay.
    { id: scriptId(SCRIPT_MOVER), location: 'synced', ctor: Mover },
]);

export const CLIENT_SCRIPTS: ScriptRegistry<ScriptId> = ScriptRegistry.from<ScriptId>([
    { id: scriptId(SCRIPT_MOVER), location: 'synced', ctor: Mover },
]);
