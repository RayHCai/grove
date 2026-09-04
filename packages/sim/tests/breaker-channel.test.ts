// The dev channel: a breaker trip reaches the host that is running the server, and nothing else.
//
// Decorator-bearing fixtures come from the build (src/testkit/fixtures.ts); this file carries no
// decorator syntax.

import { describe, expect, it } from 'vitest';
import { BREAKER_THRESHOLD } from '@platform/core';
import type { BreakerTrip } from '@platform/core';
import { FaultyRules } from '../dist/testkit/fixtures.js';
import { harness } from './harness.js';
import type { Harness } from './harness.js';

/**
 * Steps until the tick counter has reached `ticks`, rather than pumping that many times.
 *
 * The first wake establishes the driver's clock reading instead of stepping, so a fixed pump count
 * lands one tick short — and one tick short of the threshold is no trip at all.
 */
function stepTo(h: Harness, ticks: number): void {
    for (let i = 0; i < ticks * 2 && h.tick < ticks; i++) h.pumpTicks(1);
}

describe('onBreakerTrip', () => {
    it('names the script and method the server disabled, and keeps stepping', () => {
        const trips: BreakerTrip[] = [];
        const h = harness({
            config: { gameScripts: [FaultyRules as never] },
            onBreakerTrip: (trip) => trips.push(trip),
        });

        // One throw per tick, so the threshold is reached on exactly that tick.
        stepTo(h, BREAKER_THRESHOLD);

        expect(trips).toHaveLength(1);
        expect(trips[0]).toMatchObject({ scriptClass: 'FaultyRules', method: 'update' });
        expect(trips[0]!.instanceId).toBeGreaterThan(0);
        expect(trips[0]!.stack).toContain('update always throws');
        expect(trips[0]!.tick).toBe(BREAKER_THRESHOLD);

        // The point of the whole thing: a handler throwing every tick is a diagnostic, not an outage.
        const before = h.tick;
        h.pumpTicks(5);
        expect(h.tick).toBeGreaterThan(before);
    });

    it('reports the trip once, not once per later throw', () => {
        const trips: BreakerTrip[] = [];
        const h = harness({
            config: { gameScripts: [FaultyRules as never] },
            onBreakerTrip: (trip) => trips.push(trip),
        });

        stepTo(h, BREAKER_THRESHOLD * 2);

        expect(trips).toHaveLength(1);
    });

    it('puts nothing on the wire — a trip is for the host, never for a peer', () => {
        const h = harness({ config: { gameScripts: [FaultyRules as never] } });
        const peer = h.joined();
        peer.clear();

        stepTo(h, h.tick + BREAKER_THRESHOLD);

        const kinds = new Set(peer.received.map((e) => e.kind));
        expect([...kinds].every((k) => k === 'state' || k === 'transform')).toBe(true);
    });
});
