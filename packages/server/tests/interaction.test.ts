// The interaction arm: what the authority does with a HUD press and a pointer hit it cannot
// recompute, and what it refuses. Fixtures are compiled by the build.

import { afterEach, describe, expect, it } from 'vitest';
import { clearRuntime, entityKey } from '@platform/core';
import type { NetId } from '@platform/protocol';
import { Rules, Storekeeper, Touchable } from '../dist/testkit/fixtures.js';
import { MAX_INTERACTIONS_PER_FRAME, MAX_WIDGET_NAME_LENGTH } from '../src/constants.js';
import { harness } from './harness.js';
import type { Harness } from './harness.js';

afterEach(() => {
    clearRuntime();
});

function storekeeper(h: Harness): Storekeeper {
    return [...h.server.runtime.instances.forHost('game')].find(
        (i) => i.className === 'Storekeeper',
    )?.instance as Storekeeper;
}

/** The avatar's handle as the wire spells it — a NetId IS the server's EntityId. */
function avatarNetId(h: Harness, playerId: string): NetId {
    const avatar = h.server.runtime.playerManager?.byId(playerId)?.avatar;
    return avatar?.entityId as unknown as NetId;
}

function touchableOn(h: Harness, playerId: string): Touchable {
    const avatar = h.server.runtime.playerManager?.byId(playerId)?.avatar;
    avatar?.addScript(Touchable as never);
    const host = entityKey(avatar?.entityId as unknown as number);
    return [...h.server.runtime.instances.forHost(host)].find((i) => i.className === 'Touchable')
        ?.instance as Touchable;
}

describe('a widget press survives the round trip', () => {
    it('dispatches @onPress on the authority, with the player from the connection', () => {
        const h = harness({ config: { gameScripts: [Rules, Storekeeper] } });
        const peer = h.joined('a');
        const shop = storekeeper(h);

        peer.interaction(h.tick + 1, [{ kind: 'press', widget: 'buy', screen: 'shop' }]);
        h.pumpTicks(2);

        expect(shop.presses).toStrictEqual(['c1']);
        // The handler's authoritative write landed, which is the whole point of the arm existing.
        expect(shop.credits).toBe(1);
    });

    it('dispatches nothing for a widget no handler declares', () => {
        const h = harness({ config: { gameScripts: [Rules, Storekeeper] } });
        const peer = h.joined('a');

        peer.interaction(h.tick + 1, [{ kind: 'press', widget: 'sell' }]);
        h.pumpTicks(2);

        expect(storekeeper(h).presses).toStrictEqual([]);
    });

    it('drops a press that arrived before the join — identity comes from the connection', () => {
        const h = harness({ config: { gameScripts: [Rules, Storekeeper] } });
        const peer = h.connect();
        peer.interaction(1, [{ kind: 'press', widget: 'buy' }]);
        h.pumpTicks(3);

        expect(storekeeper(h).presses).toStrictEqual([]);
    });
});

describe('a pointer hit lands on the entity the client named', () => {
    it('dispatches @onClick, @onHoverEnter and @onHoverExit at that entity', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        const touchable = touchableOn(h, 'c1');
        const netId = avatarNetId(h, 'c1');

        peer.interaction(h.tick + 1, [
            { kind: 'hover-enter', netId },
            { kind: 'click', netId },
            { kind: 'hover-exit', netId },
        ]);
        h.pumpTicks(2);

        expect(touchable.clicks).toBe(1);
        expect(touchable.hoverEnters).toBe(1);
        expect(touchable.hoverExits).toBe(1);
    });

    it('drops a hit naming an entity that is not alive, rather than throwing', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        const touchable = touchableOn(h, 'c1');

        // A plausible handle that names nothing: the check is liveness, and nothing beyond it is
        // decidable here — the hit was resolved against a camera the server does not hold.
        peer.interaction(h.tick + 1, [{ kind: 'click', netId: 999_999 as NetId }]);
        h.pumpTicks(2);

        expect(touchable.clicks).toBe(0);
        expect(h.server.connections).toHaveLength(1); // and the session survives
    });
});

describe('the untrusted boundary bounds one frame before it walks it', () => {
    it('refuses a frame carrying more than MAX_INTERACTIONS_PER_FRAME events, whole', () => {
        const h = harness({ config: { gameScripts: [Rules, Storekeeper] } });
        const peer = h.joined('a');

        peer.interaction(
            h.tick + 1,
            Array.from({ length: MAX_INTERACTIONS_PER_FRAME + 1 }, () => ({
                kind: 'press' as const,
                widget: 'buy',
            })),
        );
        h.pumpTicks(2);

        // Whole, not truncated: the count is peer-chosen and the validation itself is linear in it.
        expect(storekeeper(h).presses).toStrictEqual([]);
    });

    it('refuses a frame whose widget name is empty or over the length cap', () => {
        const h = harness({ config: { gameScripts: [Rules, Storekeeper] } });
        const peer = h.joined('a');

        peer.interaction(h.tick + 1, [{ kind: 'press', widget: '' }]);
        peer.interaction(h.tick + 1, [
            { kind: 'press', widget: 'x'.repeat(MAX_WIDGET_NAME_LENGTH + 1) },
        ]);
        // A screen name is a dispatch input too, so it is capped by the same rule.
        peer.interaction(h.tick + 1, [
            { kind: 'press', widget: 'buy', screen: 'x'.repeat(MAX_WIDGET_NAME_LENGTH + 1) },
        ]);
        h.pumpTicks(2);

        expect(storekeeper(h).presses).toStrictEqual([]);
        expect(h.server.connections).toHaveLength(1);
    });

    it('ignores a frame it cannot name without ending the session', () => {
        const h = harness({ config: { gameScripts: [Rules, Storekeeper] } });
        const peer = h.joined('a');

        peer.raw({ kind: 'interaction', tick: 1, events: [{ kind: 'nonsense' }] });
        peer.raw({ kind: 'interaction', tick: 1.5, events: [] });
        peer.raw({ kind: 'interaction', tick: 1 });
        h.pumpTicks(2);

        expect(storekeeper(h).presses).toStrictEqual([]);
        expect(h.server.connections).toHaveLength(1);
    });

    it('spends an input token, so the two channels share one per-tick ceiling', () => {
        const h = harness({ config: { gameScripts: [Rules, Storekeeper] } });
        const peer = h.joined('a');
        const before = h.server.connections[0]!.admission.rateRefusals;

        // Past the bucket's depth in one wake: the refusals prove interactions draw on it rather
        // than opening a second, unmetered channel.
        for (let i = 0; i < 40; i++) {
            peer.interaction(h.tick + 1, [{ kind: 'press', widget: 'buy' }]);
        }
        h.pumpTicks(2);

        expect(h.server.connections[0]!.admission.rateRefusals).toBeGreaterThan(before);
    });
});
