// Reaching another host's script by class — the edge that replaces a module-level slot.

import { describe, expect, it } from 'vitest';
import { ClientScript, ServerScript } from '../src/script/bases.js';
import { loadGame, joinPlayer } from '../src/runtime/load-game.js';
import type { Entity } from '../src/runtime/entity.js';
import type { Game } from '../src/runtime/game.js';
import type { Player } from '../src/runtime/player.js';

class Rules extends ServerScript<Game> {
    round = 7;
}

class OtherRules extends ServerScript<Game> {
    round = 99;
}

class Profile extends ServerScript<Player> {
    credits = 3;
}

class Tumbler extends ServerScript<Entity> {
    spin = 12;
}

class Menu extends ClientScript<Player> {}

function world(): ReturnType<typeof loadGame> {
    return loadGame({ role: 'server', simRate: 60, gameScripts: [Rules] });
}

describe('Game.getScript', () => {
    it('answers the attached instance', () => {
        const rt = world();
        expect(rt.gameInstance!.getScript(Rules)?.round).toBe(7);
    });

    it('answers null for a class this host does not carry', () => {
        const rt = world();
        expect(rt.gameInstance!.getScript(OtherRules)).toBeNull();
    });

    it('is exact, never instanceof — a base class is a different script', () => {
        const rt = world();
        // `ServerScript` is `Rules`'s base, so an `instanceof` lookup would answer with it. Two
        // subclasses of one base are two scripts, and a query for the base could only guess.
        expect(rt.gameInstance!.getScript(ServerScript as never)).toBeNull();
    });
});

describe('Player.getScript', () => {
    it('reads another host’s state without a cast', () => {
        const rt = world();
        const player = joinPlayer(rt, 'p1', 'one');
        player.addScript(Profile);
        expect(player.getScript(Profile)?.credits).toBe(3);
    });

    it('keeps two players’ instances apart', () => {
        const rt = world();
        const a = joinPlayer(rt, 'a', 'a');
        const b = joinPlayer(rt, 'b', 'b');
        a.addScript(Profile);
        b.addScript(Profile);
        a.getScript(Profile)!.credits = 50;
        expect(b.getScript(Profile)?.credits).toBe(3);
    });

    it('finds a client-located script too — location is not a filter here', () => {
        const rt = world();
        const player = joinPlayer(rt, 'p1', 'one');
        player.addScript(Menu);
        // Whether a handler DISPATCHES is location's business; whether the instance exists is not.
        expect(player.getScript(Menu)).not.toBeNull();
    });
});

describe('Entity.getScript', () => {
    it('answers per entity', () => {
        const rt = world();
        const one = rt.entityManager.spawn('leaf', 0, 0);
        const two = rt.entityManager.spawn('leaf', 0, 0);
        one.addScript(Tumbler);
        expect(one.getScript(Tumbler)?.spin).toBe(12);
        expect(two.getScript(Tumbler)).toBeNull();
    });
});
