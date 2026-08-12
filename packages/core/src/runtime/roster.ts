// Spawning an avatar mints an entity from the Player template, owned by the player, and
// attaches the template's scripts including the movement class.

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
        const avatar = this.#rt.entityManager.spawn(this.avatarTemplate, cp.x, cp.y, player.id);
        player.setAvatar(avatar);
        this.#rt.wiring?.attachTemplateScripts(avatar);
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
