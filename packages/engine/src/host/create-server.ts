// createServer: an authored project and a pipe in, a booted authority out.
//
// The narrowings are @platform/project's and the boot is @platform/server's, so what lives here is
// the ORDER — validate, resolve the attached classes, build the world, and only then accept — since
// a connection admitted ahead of the world joins a game that is not there yet.

import type { KVStore } from '@platform/core';
import type { ProjectManifest, ScriptId, ScriptResolver } from '@platform/project';
import { toGameManifest, toRenderManifest, validate } from '@platform/project';
import type { ScriptRegistry } from '@platform/scripting';
import { GameServer } from '@platform/server';
import type { GameServerOptions } from '@platform/server';
import type { Transport } from '@platform/transport';
import { projectClaim } from './identity.js';

/** Where a joining client fetches this build's script chunk, and the hash the bytes must have. */
export interface BundleRef {
    url: string;
    /** Lowercase-hex SHA-256 of the bytes at `url`. */
    hash: string;
}

/** What a host supplies that a project file cannot: the loaded code, the store, and the clock. */
export interface CreateServerOptions extends Omit<GameServerOptions, 'config'> {
    /** The server chunk's classes, by the id an attachment names. Absent, no authored class is wired. */
    scripts?: ScriptRegistry<ScriptId>;
    /** The code every joiner must be running. Omitted, this build serves none and admits only clients that hold none. */
    bundle?: BundleRef;
    /** Where `@serverState` outlives a session. Omitted, it dies with the process. */
    kv?: KVStore;
}

/**
 * Boots the authority for `project` and accepts `transport` as its first connection.
 *
 * The transport is optional because a host with a listener has no connection yet when it builds the
 * server: it passes none and calls `accept` per socket. It does not start a clock either — `pump`
 * and `start` are the host's, and which one it calls decides whether the join deadline is swept.
 */
export function createServer(
    project: ProjectManifest,
    transport?: Transport,
    opts: CreateServerOptions = {},
): GameServer {
    const { scripts, bundle, kv, ...forwarded } = opts;
    // A type is a compile-time claim and a saved project is bytes someone wrote, so this checks
    // rather than casts — and it is why the validator is not part of what a creator imports.
    const manifest = validate(project);
    const resolve: ScriptResolver = (id) => scripts?.resolve(id);
    const world = toGameManifest(manifest, { role: 'server', scripts: resolve });
    const settings = manifest.settings;

    const server = new GameServer({
        config: {
            simRate: world.simRate,
            // Not on the game manifest: no reader in core has one, so both come off the settings.
            sendRate: settings.sendRate,
            maxPlayers: settings.maxPlayers,
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
            ...(scripts === undefined ? {} : { scripts }),
            project: {
                ...projectClaim(manifest),
                bundleHash: bundle?.hash ?? '',
                bundleUrl: bundle?.url ?? '',
            },
            ...(kv === undefined ? {} : { kv }),
        },
        ...forwarded,
    });

    // After the constructor, which builds the world and runs every Game start handler to its first
    // await: a peer accepted before that would be joining a world still being assembled.
    if (transport !== undefined) server.accept(transport);
    return server;
}
