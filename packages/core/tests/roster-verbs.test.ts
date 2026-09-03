// The four verbs that give a player a body and take it away again.
//
// Each is one line on `Player` delegating to the roster, which is why the interesting behaviour is
// what the roster does around them: where a respawn puts the new avatar, what a spectate leaves
// behind, and which of them a player with no body may be asked for.

import { describe, it, expect, afterEach } from 'vitest';
import { joinPlayer, loadGame } from '../src/runtime/load-game.js';
import { clearRuntime } from '../src/runtime/runtime.js';
import type { Runtime } from '../src/runtime/runtime.js';
import type { Player } from '../src/runtime/player.js';

afterEach(() => clearRuntime());

function seated(rt: Runtime, id = 'p1'): Player {
    const player = joinPlayer(rt, id, id.toUpperCase());
    player.spawn();
    return player;
}

describe('spawn', () => {
    it('mints an avatar from the roster’s own template key, owned by the player', () => {
        const rt = loadGame();
        const player = seated(rt);
        expect(player.hasAvatar).toBe(true);
        // Named by core rather than by any project: a manifest whose avatar template is called
        // something else spawns nothing here.
        expect(rt.entities.record(player.avatar.entityId)?.template).toBe('player');
        expect(player.avatar.owner?.id).toBe(player.id);
    });

    it('puts the avatar at the authored default when the player has no checkpoint', () => {
        const rt = loadGame();
        rt.wired.roster.defaultSpawn = { x: 25, y: -15 };
        const player = seated(rt);
        expect(player.avatar.position.x).toBe(25);
        expect(player.avatar.position.y).toBe(-15);
    });
});

describe('teleportTo', () => {
    it('moves the avatar the player currently has', () => {
        const rt = loadGame();
        const player = seated(rt);
        player.teleportTo(40, 60);
        expect(player.avatar.position.x).toBe(40);
        expect(player.avatar.position.y).toBe(60);
    });

    it('is a no-op for a bodiless player rather than throwing on the missing avatar', () => {
        const rt = loadGame();
        const player = joinPlayer(rt, 'p1', 'P');
        expect(() => player.teleportTo(10, 10)).not.toThrow();
        expect(player.hasAvatar).toBe(false);
    });

    it('does not move the checkpoint, so a respawn returns to where the spawn was', () => {
        const rt = loadGame();
        rt.wired.roster.defaultSpawn = { x: 5, y: 5 };
        const player = seated(rt);
        player.teleportTo(200, 200);

        player.respawn();
        expect(player.avatar.position.x).toBe(5);
        expect(player.avatar.position.y).toBe(5);
    });
});

describe('spectate', () => {
    it('destroys the body and leaves the player on the roster without one', () => {
        const rt = loadGame();
        const player = seated(rt);
        const was = player.avatar;

        player.spectate();
        expect(was.alive).toBe(false);
        expect(player.hasAvatar).toBe(false);
        // The roster still holds them: spectating is not leaving.
        expect(rt.wired.playerManager.byId(player.id)).not.toBeNull();
    });

    it('throws only when the missing avatar is actually asked for', () => {
        const rt = loadGame();
        const player = seated(rt);
        player.spectate();
        expect(() => player.avatar).toThrow();
    });

    it('is safe to call twice, because the second has nothing left to destroy', () => {
        const rt = loadGame();
        const player = seated(rt);
        player.spectate();
        expect(() => player.spectate()).not.toThrow();
        expect(player.hasAvatar).toBe(false);
    });
});

describe('respawn', () => {
    it('replaces the body rather than moving it', () => {
        const rt = loadGame();
        const player = seated(rt);
        const was = player.avatar;

        player.respawn();
        expect(was.alive).toBe(false);
        expect(player.hasAvatar).toBe(true);
        expect(player.avatar.entityId).not.toBe(was.entityId);
    });

    it('gives a spectating player a body back', () => {
        const rt = loadGame();
        const player = seated(rt);
        player.spectate();
        player.respawn();
        expect(player.hasAvatar).toBe(true);
    });

    it('honours a checkpoint set for that player over the authored default', () => {
        const rt = loadGame();
        rt.wired.roster.defaultSpawn = { x: 0, y: 0 };
        const player = seated(rt);
        rt.wired.roster.setCheckpoint(player, 70, -30);

        player.respawn();
        expect(player.avatar.position.x).toBe(70);
        expect(player.avatar.position.y).toBe(-30);
    });

    it('keeps one player’s checkpoint out of another’s respawn', () => {
        const rt = loadGame();
        const one = seated(rt, 'p1');
        const two = seated(rt, 'p2');
        rt.wired.roster.setCheckpoint(one, 90, 90);

        two.respawn();
        expect(two.avatar.position.x).toBe(0);
        expect(two.avatar.position.y).toBe(0);
    });
});
