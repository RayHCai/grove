// What the HOST owes the HUD, now that the HUD itself is a script.
//
// Two things, and they are the two a script cannot do. It cannot open the first screen — a panel
// would, and this app has none, so the session start stands in. And it cannot touch the renderer:
// `hud.*` writes widgets, and a node on the `ui` surface is drawing, which is the host's.
//
// Everything that used to be here — reading replicated state, diffing it, formatting it, choosing
// which menu is up — is `scripts/screens/hud.ts`, where the authored model puts it.

import type { GameClient } from '@platform/client';
import { hud, withRuntime } from '@platform/core';
import type { IRenderer, NodeId } from '@platform/renderer';
// The LOWERED copies: every script carries decorators, and Vite's transform would hand them to the
// browser verbatim. `tsc -p tsconfig.server.json` emits these, which is why `dev` runs it first.
import { HudScreen } from '../dist/scripts/screens/hud.js';
import { LobbyScreen } from '../dist/scripts/screens/lobby.js';
import { SCREEN_HUD, SCREEN_LOBBY, STATE_PHASE, STATE_SECONDS_LEFT } from './scripts/globals';
import { readState } from './scripts/state';

/** Where the in-canvas clock sits on the UI surface, and how it is drawn. */
const CLOCK_OFFSET_Y = 24;
const CLOCK_STYLE = {
    size: 30,
    color: 0xf2f7f3,
    weight: 'bold' as const,
    align: 'center' as const,
};

/**
 * Registers the game's screens and opens the always-on one.
 *
 * A screen is minted on first mention and `hud.screen` answers null until then, so the open-and-
 * close pair below is the only way to reach one before the open that runs it. In a hosted platform
 * the panel does this from the project file; here the session start is the panel.
 */
export function openHud(client: GameClient): void {
    const rt = client.mirror?.runtime;
    if (rt === undefined) return;
    withRuntime(rt, () => {
        for (const [name, klass] of [
            [SCREEN_HUD, HudScreen],
            [SCREEN_LOBBY, LobbyScreen],
        ] as const) {
            hud.open(name);
            const screen = hud.screen(name);
            // Registered ONCE per runtime: `addScript` appends, so calling this a second time on
            // one mirror would attach the class twice and run every handler twice with it. A
            // resync builds a fresh runtime, where the list is empty again and this refills it.
            if (screen !== null && screen.scripts.length === 0) screen.addScript(klass as never);
            hud.close(name);
        }
        // The overlay is always up, and its own `@onUpdate` opens and closes the other two.
        hud.open(SCREEN_HUD);
    });
}

/**
 * Presses a widget with this client's own runtime made current.
 *
 * `pressWidget` establishes the ambient runtime itself now, but the press below is raised from a
 * DOM handler rather than from a frame — so this is where the local player's world is named.
 */
export function pressWidget(client: GameClient, widget: string, screen?: string): void {
    const rt = client.mirror?.runtime;
    if (rt === undefined) return;
    withRuntime(rt, () => client.pressWidget(widget, screen));
}

/**
 * The round clock, drawn on the renderer's `ui` surface.
 *
 * Screen space, so it neither scrolls with the camera nor culls — and text is legal only there: a
 * text node on a camera-transformed surface throws, and world text is an asset instead. It reads
 * the same replicated fields the screen script does, because a node is not a widget and no `hud`
 * verb can reach one.
 */
export class ClockNode {
    readonly #renderer: IRenderer;
    #node: NodeId | undefined;
    #shown = '';

    constructor(renderer: IRenderer) {
        this.#renderer = renderer;
    }

    /** Called once per frame, behind the client's own. */
    sync(client: GameClient): void {
        const rt = client.mirror?.runtime;
        const world = rt?.gameInstance;
        const phase = readState<string>(world, STATE_PHASE) ?? '';
        const label =
            phase === 'playing' ? String(readState<number>(world, STATE_SECONDS_LEFT) ?? 0) : '';
        if (label === this.#shown && this.#node !== undefined) return;
        this.#shown = label;

        if (this.#node === undefined) {
            this.#node = this.#renderer.createNode({
                kind: 'text',
                surface: 'ui',
                uiAnchor: 'top-center',
                position: { x: 0, y: CLOCK_OFFSET_Y, z: 0 },
                text: label,
                style: CLOCK_STYLE,
            });
            return;
        }
        if (this.#renderer.isAlive(this.#node)) this.#renderer.setNodeText(this.#node, label);
    }

    /** Destroys the one node this owns. The client's own bridge destroys only what it created. */
    dispose(): void {
        const node = this.#node;
        if (node === undefined) return;
        this.#node = undefined;
        if (this.#renderer.isAlive(node)) this.#renderer.destroyNode(node);
    }
}
