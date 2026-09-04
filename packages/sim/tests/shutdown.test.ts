// What a shutdown owes the host: every online named player's save, and nothing for a peer nobody
// named. Whether those writes land is the host's, and `@platform/glue`'s suite is where that is.

import { afterEach, describe, expect, it } from 'vitest';
import { clearRuntime, playerKey } from '@platform/core';
import { Accounts, Wallet } from '../dist/testkit/fixtures.js';
import type { Sim } from '../src/sim.js';
import { harness } from './harness.js';

afterEach(() => clearRuntime());

function walletOf(sim: Sim, id: string): Wallet {
    return [...sim.runtime.instances.forHost(playerKey(id))]
        .map((si) => si.instance)
        .find((i): i is Wallet => i instanceof Wallet)!;
}

describe('close() hands back every save a shutdown owes', () => {
    it('orders an online player’s state written through', async () => {
        const h = harness({ config: { gameScripts: [Accounts] } });
        await h.joinedAs('alice');
        walletOf(h.sim, 'alice').credits = 42;
        h.pumpTicks(2);

        // Every deploy and every container eviction runs this path, so a save the shutdown never
        // asked for is silent, total loss for every player who was online.
        const out = h.sim.close();
        expect(out.saves).toEqual([
            { hostKey: playerKey('alice'), fields: expect.objectContaining({ credits: 42 }) },
        ]);
    });

    it('is idempotent, and a second call orders nothing further', async () => {
        const h = harness({ config: { gameScripts: [Accounts] } });
        await h.joinedAs('alice');
        walletOf(h.sim, 'alice').credits = 7;
        h.pumpTicks(2);

        expect(h.sim.close().saves).toHaveLength(1);
        expect(h.sim.close().saves).toHaveLength(0);
        expect(h.sim.closed).toBe(true);
    });

    it('orders nothing durable for a connection the host never named', () => {
        const h = harness({ config: { gameScripts: [Accounts] } });
        const peer = h.joined('anon');
        walletOf(h.sim, 'c1').credits = 3;
        h.pumpTicks(2);
        peer.close();
        h.pumpTicks(2);

        // A connection id is minted per socket, so a record under one is unreadable by anybody —
        // one leaked KV entry per join/leave cycle, forever.
        expect(h.saves).toHaveLength(0);
        expect(h.sim.close().saves).toHaveLength(0);
    });

    it('is inert afterwards: a later tick neither advances nor answers anything', async () => {
        const h = harness({ config: { gameScripts: [Accounts] } });
        const peer = await h.joinedAs('alice');
        h.pumpTicks(2);
        const at = h.tick;

        h.close();
        peer.clear();
        h.pumpTicks(8);

        expect(h.tick).toBe(at);
        expect(peer.received).toHaveLength(0);
    });
});
