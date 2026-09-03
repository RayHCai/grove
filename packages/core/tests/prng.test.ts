// The world's PRNG is one stream both ends of the wire have to agree about, so what it starts from
// cannot be a literal inside core: a seed only the constructor knows is a seed no server can tell a
// client, and every session then replays the same numbers.

import { describe, it, expect, afterEach } from 'vitest';
import { DEFAULT_PRNG_SEED } from '../src/config.js';
import { loadGame } from '../src/runtime/load-game.js';
import { clearRuntime } from '../src/runtime/runtime.js';
import type { Runtime } from '../src/runtime/runtime.js';

afterEach(() => clearRuntime());

/** Ten draws, which is more than enough for two streams to differ if they are going to. */
function draws(rt: Runtime): number[] {
    return Array.from({ length: 10 }, () => rt.wired.random.between(0, 1000));
}

describe('the load seed', () => {
    it('is what two worlds must share to draw the same stream', () => {
        expect(draws(loadGame({}, { seed: 12_345 }))).toStrictEqual(
            draws(loadGame({}, { seed: 12_345 })),
        );
    });

    it('diverges for a different one', () => {
        expect(draws(loadGame({}, { seed: 12_345 }))).not.toStrictEqual(
            draws(loadGame({}, { seed: 12_346 })),
        );
    });

    it('defaults to the documented seed, so an unseeded world is still reproducible', () => {
        expect(draws(loadGame())).toStrictEqual(draws(loadGame({}, { seed: DEFAULT_PRNG_SEED })));
    });

    it('survives capture and apply, which is what lets a peer be handed the position', () => {
        // Replication needs the stream POSITION, not the seed: a mirror that re-seeded would start
        // over while the server kept going.
        const rt = loadGame({}, { seed: 999 });
        draws(rt);

        const buffer = rt.prng.createBuffer();
        rt.prng.capture(buffer, null);
        const expected = draws(rt);

        const other = loadGame({}, { seed: 1 });
        other.prng.apply(buffer);
        expect(draws(other)).toStrictEqual(expected);
    });
});
