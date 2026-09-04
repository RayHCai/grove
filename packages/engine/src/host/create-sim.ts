// The narrowings are @platform/project's and the boot is @platform/sim's, so what lives here is the
// ORDER — validate, resolve the attached classes, then build the world — since the returned sim must
// not be able to take a connection into a world that is not there yet.

import type { KVStore } from '@platform/core';
import { defined } from '@platform/math';
import type { ProjectManifest, ScriptId, ScriptResolver } from '@platform/project';
import { toGameManifest, toRenderManifest, toServerSettings, validate } from '@platform/project';
import type { ScriptRegistry } from '@platform/scripting';
import { Sim } from '@platform/sim';
import type { SimOptions } from '@platform/sim';
import { projectClaim } from './identity.js';

/** Where a joining client fetches this build's script chunk, and the hash the bytes must have. */
export interface BundleRef {
    url: string;
    /** Lowercase-hex SHA-256 of the bytes at `url`. */
    hash: string;
}

/** What a host supplies that a project file cannot: the loaded code, and the seams around it. */
export interface CreateSimOptions extends Omit<SimOptions, 'config'> {
    /** The server chunk's classes, by the id an attachment names. Absent, no authored class is wired. */
    scripts?: ScriptRegistry<ScriptId>;
    /** The code every joiner must be running. Omitted, this build serves none and admits only clients that hold none. */
    bundle?: BundleRef;
    /** The storage a `ServerScript` awaits. Omitted, it dies with the process. */
    kv?: KVStore;
}

/**
 * Boots the authority for `project`, connected to nothing and running no clock.
 *
 * A host drives what this returns with `tick(batch)`, one call per fixed step, and does the sockets,
 * the storage and the timekeeping itself — none of which this world can reach.
 */
export function createSim(project: ProjectManifest, opts: CreateSimOptions = {}): Sim {
    const { scripts, bundle, kv, ...forwarded } = opts;
    // A type is a compile-time claim and a saved project is bytes someone wrote, so this checks
    // rather than casts — and it is why the validator is not part of what a creator imports.
    const manifest = validate(project);
    const resolve: ScriptResolver = (id) => scripts?.resolve(id);
    const world = toGameManifest(manifest, { role: 'server', scripts: resolve });
    const wire = toServerSettings(manifest);

    // The constructor builds the world and runs every Game start handler to its first await, so the
    // world this returns is already safe for the caller to take a connection into.
    return new Sim({
        config: {
            simRate: world.simRate,
            sendRate: wire.sendRate,
            maxPlayers: wire.maxPlayers,
            bounds: world.bounds,
            regions: world.regions,
            visuals: toRenderManifest(manifest),
            // The registry before the scene, and the scene before `accept`: instantiating a
            // template is what puts its scripts and its subtree on an entity, so a world built
            // against an empty registry is a world of bare entities nothing runs on.
            templates: world.templates,
            entities: world.entities,
            // Whole attachments, not bare classes: a Game script has an inspector too, and dropping
            // its props here would leave one configured field silently at its initializer.
            gameScripts: world.gameScripts,
            ...defined({ scripts }),
            project: {
                ...projectClaim(manifest),
                bundleHash: bundle?.hash ?? '',
                bundleUrl: bundle?.url ?? '',
            },
            ...defined({ kv }),
        },
        ...forwarded,
    });
}
