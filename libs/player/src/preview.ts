// A world running in the page that is also showing it. Kept out of the package root deliberately:
// this reaches `@platform/glue/world`, and a deployed player has no business carrying a Sim.

import { GameInstance } from '@platform/glue/world';
import { ScriptRegistry, locationsFor } from '@platform/scripting';
import type { ScriptEntry } from '@platform/scripting';
import type { ProjectManifest, ScriptId } from '@platform/project';
import { loopbackPair } from '@platform/transport';
import type { GameAuthority, LocalLink } from './GamePlayer.js';

/**
 * What a game hands this page when the world runs here rather than on a box.
 *
 * The same two things a deployed session gets from two different places — the authored world, and
 * the classes an `attach` names — except that here one module graph serves both halves, so the
 * entries carry every location and each side filters to its own.
 */
export interface PreviewGame {
    project: ProjectManifest;
    scripts: readonly ScriptEntry<ScriptId>[];
    /** Where the world's diagnostics go; without one there is no record of why a session died. */
    onLog?: ((line: string) => void) | undefined;
}

/** A world running in this page, and the session's end of the pair that reaches it. */
export interface Preview {
    authority: GameAuthority;
    /** What the session claims, derived from the same manifest the world booted from. */
    project: { projectId: string; projectHash: string };
    /**
     * Advances the world by hand, against `nowSeconds` if one is given.
     *
     * The boot starts an interval that does this against the wall clock, which is what a browser
     * preview wants. The argument is what makes a caller holding its own clock possible at all —
     * without it this reads the wall clock too, and "drive the world by hand" would mean "wait".
     *
     * A caller driving its own clock must `pause()` first. Two clocks on one world is a driver
     * told that time both did and did not pass, and it answers by advancing neither.
     */
    pump: (nowSeconds?: number) => void;
    /**
     * Stops the clock without ending the world, and starts it again.
     *
     * A paused stage is a world nobody is ticking, not a world that has closed: the sessions stay
     * up, their sockets stay open, and resuming carries on from the tick it stopped at.
     */
    pause: () => void;
    resume: () => void;
    /** Ends the world. Called when the page is done with the preview, not with one session. */
    dispose: () => void;
}

/** The id a previewing creator joins as. One tab, one player, no allocator to mint one. */
const PREVIEW_PLAYER = 'preview';

/**
 * Boots a world in this page and answers what to mount a session against.
 *
 * The authority is a real `GameInstance` over a real `Sim` — the same one `@grove/game-instance`
 * runs in Rust — so what a preview shows is the world a deployed session would show, less the
 * socket between them. It declares no bundle, because there is nothing to fetch: the classes are
 * already here, and the session is handed them rather than told where to look.
 */
export function bootPreview(game: PreviewGame): Preview {
    // One registry, filtered per side. The wire names a `ScriptId` and each end resolves it, so
    // handing an authority a client-located class would let an `attach` reach code no tick runs.
    const registry = (side: 'server' | 'client'): ScriptRegistry<ScriptId> => {
        const locations = locationsFor(side);
        return ScriptRegistry.from(game.scripts.filter((s) => locations.has(s.location)));
    };

    const instance = new GameInstance({
        project: game.project,
        scripts: registry('server'),
        ...(game.onLog === undefined ? {} : { onLog: game.onLog }),
    });

    // The clock is held here rather than started on the instance, because `start()` owns an
    // interval it offers no way back to and a stage with a pause button needs one.
    const interval = 1000 / game.project.settings.simRate;
    let timer: ReturnType<typeof setInterval> | undefined = setInterval(
        () => instance.pump(),
        interval,
    );

    return {
        authority: {
            kind: 'local',
            scripts: registry('client'),
            open: (): LocalLink => {
                const pair = loopbackPair();
                // The world takes its end before the session takes its own: a join frame that
                // arrived at an authority not yet listening is one nothing ever answers.
                instance.accept(pair.server, PREVIEW_PLAYER);
                return {
                    transport: pair.client,
                    // A pair only moves when somebody turns it. The session turns it at the top of
                    // every frame, which is what a real socket does on its own.
                    pump: () => pair.deliver(),
                    close: () => pair.client.close(),
                };
            },
        },
        project: {
            projectId: game.project.projectId,
            // `contentHash` IS `projectHash` on the wire — the handshake compares a digest of what
            // was authored, and the two names are one value.
            projectHash: game.project.contentHash,
        },
        pump: (nowSeconds?: number) => {
            instance.pump(nowSeconds);
        },
        pause: () => {
            if (timer === undefined) return;
            clearInterval(timer);
            timer = undefined;
        },
        resume: () => {
            timer ??= setInterval(() => instance.pump(), interval);
        },
        dispose: () => {
            if (timer !== undefined) clearInterval(timer);
            timer = undefined;
            void instance.close();
        },
    };
}
