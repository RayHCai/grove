// Spawning an avatar instantiates the Player template, owned by the player, and attaches the
// movement class over whatever that template already carries.

import { instantiate } from '../world/templates.js';
import type { Runtime } from './runtime.js';
import type { Player } from './player.js';
import type { BaseMovement } from './movement.js';
import type { Entity } from './entity.js';

interface Checkpoint {
    x: number;
    y: number;
}

export class Roster {
    readonly #rt: Runtime;
    readonly #checkpoints = new Map<string, Checkpoint>();
    /** One slot, not a list: an avatar carries at most one movement class. */
    movementClass: (new () => BaseMovement) | null = null;
    /** Panel-authored default spawn point. */
    defaultSpawn: Checkpoint = { x: 0, y: 0 };
    /** The Player template key the avatar spawns from. */
    avatarTemplate = 'player';

    constructor(rt: Runtime) {
        this.#rt = rt;
    }

    spawnAvatar(player: Player): void {
        const cp = this.#checkpoints.get(player.id) ?? this.defaultSpawn;
        // Through `instantiate`, so the Player template's own scripts and subtree are what an
        // avatar is — the roster configures the movement class and nothing else about it.
        const avatar = instantiate(this.#rt, this.avatarTemplate, {
            x: cp.x,
            y: cp.y,
            ownerId: player.id,
        });
        player.setAvatar(avatar);
        if (this.movementClass) this.setMovement(player, this.movementClass);
    }

    spectate(player: Player): void {
        const avatar = this.#tryAvatar(player);
        if (avatar) avatar.destroy();
        player.setAvatar(null);
        player.clearMovement();
    }

    respawn(player: Player): void {
        const avatar = this.#tryAvatar(player);
        if (avatar) avatar.destroy();
        player.setAvatar(null);
        this.spawnAvatar(player);
    }

    setMovement(player: Player, movement: new () => BaseMovement): void {
        const avatar = this.#tryAvatar(player);
        if (!avatar) return;
        const instance = this.#rt.wiring?.attachMovement(avatar, movement) as
            BaseMovement | undefined;
        player.setMovementInstance(instance);
    }

    setCheckpoint(player: Player, x: number, y: number): void {
        this.#checkpoints.set(player.id, { x, y });
    }

    #tryAvatar(player: Player): Entity | null {
        return player.hasAvatar ? player.avatar : null;
    }
}
