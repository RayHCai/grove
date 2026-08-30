// createClient: a project and this machine's seams in, a session that can join out.
//
// What it adds over `new GameClient` is the identity this client claims — derived from the same
// manifest the authority booted from, so the two ends agree at the handshake rather than diverging
// later through code that only looks the same.

import { GameClient } from '@platform/client';
import type { GameClientOptions } from '@platform/client';
import { defined } from '@platform/math';
import type { ProjectManifest, ScriptId } from '@platform/project';
import type { ScriptRegistry } from '@platform/scripting';
import { projectClaim } from './identity.js';

export interface CreateClientOptions extends Omit<GameClientOptions, 'project' | 'scripts'> {
    /** What this client is playing, proved against the server's before a `Player` is allocated. */
    project?: ProjectManifest;
    /** The client chunk's classes, by the id an attachment names — what prediction has to run. */
    scripts?: ScriptRegistry<ScriptId>;
    /** The bundle this process has already verified; `''` until it has loaded one. */
    bundleHash?: string;
}

/**
 * Builds a session for `project` over the supplied seams. It does not join: `start()` is the host's,
 * so a lifecycle listener can be registered before the first state change.
 */
export function createClient(opts: CreateClientOptions): GameClient {
    const { project, scripts, bundleHash, ...forwarded } = opts;
    return new GameClient({
        ...forwarded,
        // No project declared is a real answer rather than a missing one, and the client's own
        // all-empty default already says it — so an absent manifest is left to say it.
        ...defined({
            project:
                project === undefined
                    ? undefined
                    : { ...projectClaim(project), bundleHash: bundleHash ?? '' },
        }),
        // Passed through whole: the wire names a `ScriptId` and the mirror resolves it, so there is
        // one table keyed one way. Filtering by location happens at the attach site instead, which
        // is the only place that knows an `attach` op arrived for an entity at all.
        ...defined({ scripts }),
    });
}
