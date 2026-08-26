// The authoritative game: the only file in this app that carries decorator syntax.
//
// It is compiled by `tsconfig.server.json` and never enters the browser bundle, because `tsc` is
// the only tool in this repo that lowers TC39 standard decorators — Vite's oxc transform passes
// them through untouched and Node then refuses to parse them.
//
// Nothing here reads core's `game` module const. Core keeps ONE module-global runtime, and a
// `GameClient` in the same process would repoint it; every path below goes through `this.host` or
// the Game captured at start, so the world a handler writes is always its own.

import type { Ctx, Entity, Game, Player } from '@platform/core';
import {
    ServerScript,
    onEvent,
    onEventHold,
    onPlayerJoin,
    onStart,
    onUpdate,
} from '@platform/core';
import {
    ACTION_AIM_Y,
    ACTION_CLEAR,
    ACTION_SPAWN,
    AVATAR_Y,
    LEAF_TEMPLATE,
    avatarX,
    decodeAim,
    markerTemplate,
} from '../shared.js';
import { Runner } from '../synced/runner.js';
import {
    LEAF_LAYER,
    LEAF_SCALE,
    MARKER_LAYER,
    MARKER_OFFSET_Y,
    MARKER_OPACITY,
    MARKER_SCALE,
    clampToWorld,
    hasExited,
    spawnX,
    stepLeaf,
} from './leaf.js';

/** Marks the entities the drift pass advances, which excludes each leaf's parented shadow. */
const LEAF_TAG = 'leaf';

/**
 * The world every handler writes, captured once at start.
 *
 * A player-hosted script has no route back to the Game — `Player` holds no reference to one — and
 * core's `game` const reads a module-global that a co-located client would repoint.
 */
let world: Game | null = null;

/**
 * Spawns one leaf, plus the badge parented above it in the spawner's colour.
 *
 * The tint rides the badge's template, so `playerIndex` picks which one — a transform diff carries
 * no colour, and a template is the only per-entity route a tint has to the wire.
 *
 * Ownership is deliberately left unset. `GameServer` destroys every entity whose `ownerId` matches
 * a departing player, so an owned leaf would vanish from every other tab the moment the tab that
 * spawned it closed — the badge says who spawned it without the world agreeing that they own it.
 */
function spawnLeaf(game: Game, worldY: number, playerIndex: number): void {
    const bounds = game.bounds;
    const y = clampToWorld(worldY, bounds);

    const leaf = game.spawn(LEAF_TEMPLATE, spawnX(bounds), y);
    leaf.tag(LEAF_TAG);
    leaf.setRotation(0);
    leaf.setScale(LEAF_SCALE);
    leaf.layer = LEAF_LAYER;

    // Follows its parent's position but inherits neither its rotation nor its scale, which is what
    // keeps the badge upright over a tumbling leaf — and gives the inspector a real two-level tree.
    const badge = game.spawn(markerTemplate(playerIndex), 0, MARKER_OFFSET_Y);
    badge.setScale(MARKER_SCALE);
    badge.opacity = MARKER_OPACITY;
    badge.layer = MARKER_LAYER;
    badge.attachTo(leaf);
}

function liveLeaves(game: Game): Entity[] {
    return game.find({ tag: LEAF_TAG });
}

/** The Game-hosted rules: the roster, the drift pass, and the reap. */
export class Rules extends ServerScript<Game> {
    @onStart
    begin(): void {
        world = this.host;
    }

    /**
     * Input reaches a player host and an avatar host, never the Game host, so the click handler
     * has to be attached per player rather than declared here.
     *
     * The avatar is minted here rather than by the roster's template scripts, which resolve no class:
     * `spawn()` owns it to this player, which is what puts it inside that client's predicted scope and
     * what makes `GameServer` reap it when the tab closes.
     */
    @onPlayerJoin
    join(ctx: Ctx): void {
        const player = ctx.player;
        if (!player) return;
        player.addScript(Clicker);
        player.spawn();
        player.teleportTo(avatarX(player.index), AVATAR_Y);
        player.avatar.addScript(Runner);
    }

    @onUpdate
    drift(ctx: Ctx): void {
        const game = this.host;
        const bounds = game.bounds;

        for (const leaf of liveLeaves(game)) {
            const next = stepLeaf(leaf.position.x, leaf.rotation, ctx.dt);
            if (hasExited(next.x, bounds)) {
                leaf.destroy();
                continue;
            }
            leaf.setPosition(next.x, leaf.position.y);
            leaf.setRotation(next.rotation);
        }
    }
}

/**
 * One per connected player: it turns that player's input into world changes.
 *
 * The work happens on the update pass rather than in the press handler because a press is
 * dispatched before that tick's axis samples are, so the click's y is only current one pass later.
 */
export class Clicker extends ServerScript<Player> {
    #aimY = 0;
    #pending = 0;
    #clearing = false;

    @onEventHold(ACTION_AIM_Y)
    aim(ctx: Ctx): void {
        const value = ctx.value;
        if (value === undefined) return;
        this.#aimY = decodeAim(value);
    }

    @onEvent(ACTION_SPAWN)
    click(): void {
        this.#pending += 1;
    }

    @onEvent(ACTION_CLEAR)
    clear(): void {
        this.#clearing = true;
    }

    @onUpdate
    apply(): void {
        const game = world;
        if (game === null) return;

        if (this.#clearing) {
            this.#clearing = false;
            for (const leaf of liveLeaves(game)) leaf.destroy();
        }

        while (this.#pending > 0) {
            this.#pending -= 1;
            spawnLeaf(game, this.#aimY, this.host.index);
        }
    }
}

/** Drops the captured world, so a second server in one process does not inherit the first's. */
export function resetWorld(): void {
    world = null;
}
