// The clock: the lead closes on headroom without winding up, the nudge is the only thing
// that moves the counter, and a suspended tab is distinguishable from a slow path.

import { describe, expect, it } from 'vitest';
import { ClientClock } from '../src/clock.js';
import { HEADROOM_TARGET, LEAD_MAX_SECONDS, NUDGE_MAX } from '../src/constants.js';

function clock(
    over: { simRate?: number; snapshotTick?: number; rttSeconds?: number } = {},
): ClientClock {
    return new ClientClock({
        simRate: over.simRate ?? 60,
        snapshotTick: over.snapshotTick ?? 0,
        rttSeconds: over.rttSeconds ?? 0.05,
    });
}

/** Drives `frames` display frames of `dt`, returning every tick index stamped, in order. */
function run(c: ClientClock, frames: number, dt = 1 / 60, from = 0): number[] {
    const stamped: number[] = [];
    let now = from;
    for (let i = 0; i <= frames; i++) {
        stamped.push(...c.advance(now));
        now += dt;
    }
    return stamped;
}

/** Feeds `acks` samples at a fixed measured headroom, letting the nudge deliver between each. */
function settle(c: ClientClock, headroom: number, acks: number, framesPerAck = 3): void {
    for (let i = 0; i < acks; i++) {
        const leadAtSend = c.currentLeadTicks;
        run(c, framesPerAck);
        c.sample({ headroom, leadAtSendTicks: leadAtSend });
    }
}

describe('the seed', () => {
    it('seeds the counter from the snapshot tick plus the lead in ticks', () => {
        // One RTT, UNHALVED: downlink to reach server-now, uplink to reach server-future.
        const c = clock({ simRate: 60, snapshotTick: 1000, rttSeconds: 0.1 });
        expect(c.currentLeadSeconds).toBeCloseTo(0.1, 10);
        expect(c.localTick).toBe(1000 + Math.ceil(0.1 * 60));
    });

    it('stores the lead in SECONDS, so one latency yields one duration at any simRate', () => {
        // A tick-valued constant would mean 100 ms of input delay at 60 Hz and 300 ms at 20 Hz —
        // same connection, triple the latency, for a reason nobody would look for in a rate setting.
        const fast = clock({ simRate: 60, rttSeconds: 0.09 });
        const slow = clock({ simRate: 20, rttSeconds: 0.09 });
        expect(fast.currentLeadSeconds).toBeCloseTo(slow.currentLeadSeconds, 10);
        expect(fast.currentLeadTicks).toBeCloseTo(slow.currentLeadTicks * 3, 6);
    });

    it('floors the lead at one tick, which is loopback’s structural minimum', () => {
        expect(clock({ simRate: 60, rttSeconds: 0 }).currentLeadSeconds).toBeCloseTo(1 / 60, 10);
        expect(clock({ simRate: 20, rttSeconds: 0 }).currentLeadSeconds).toBeCloseTo(1 / 20, 10);
    });

    it('caps the lead at LEAD_MAX, past which the input is unusable anyway', () => {
        expect(clock({ rttSeconds: 5 }).currentLeadSeconds).toBe(LEAD_MAX_SECONDS);
    });
});

describe('the accumulator', () => {
    it('stamps every tick index exactly once, in order', () => {
        const c = clock({ snapshotTick: 0, rttSeconds: 0 });
        const start = c.localTick;
        const stamped = run(c, 60);
        expect(stamped).toEqual(stamped.toSorted((a, b) => a - b));
        expect(new Set(stamped).size).toBe(stamped.length);
        expect(stamped[0]).toBe(start + 1);
    });

    it('advances zero, one, or several ticks per frame', () => {
        const c = clock({ simRate: 60, rttSeconds: 0 });
        // A 144 Hz display: most frames advance no tick.
        expect(c.advance(0)).toHaveLength(0);
        expect(c.advance(1 / 144)).toHaveLength(0);
        // A frame worth three ticks advances three.
        const c2 = clock({ simRate: 60, rttSeconds: 0 });
        c2.advance(0);
        expect(c2.advance(3 / 60)).toHaveLength(3);
    });

    it('is inert under a backwards or non-finite clock — no rewind, accumulator unpoisoned', () => {
        const c = clock({ rttSeconds: 0 });
        c.advance(10);
        const at = c.localTick;
        expect(c.advance(5)).toHaveLength(0); // backwards
        expect(c.advance(Number.NaN)).toHaveLength(0);
        expect(c.advance(Number.POSITIVE_INFINITY)).toHaveLength(0);
        expect(c.localTick).toBe(at);
        // And the accumulator still works afterwards.
        expect(c.advance(10 + 1 / 60).length).toBeGreaterThan(0);
    });

    it('does not treat a clamped dt as a deficit to make up', () => {
        // After a scripted multi-second gap the counter must not run fast to recover discarded
        // wall-clock time — the clamp is doing its job, which is why suspension is detected by the behind-check instead.
        const c = clock({ simRate: 60, rttSeconds: 0 });
        c.advance(0);
        const jumped = c.advance(30).length; // 30 s in one frame
        expect(jumped).toBeLessThanOrEqual(Math.ceil(0.1 * 60) + 1);
        // The next ordinary frame advances an ordinary number of ticks.
        expect(c.advance(30 + 1 / 60).length).toBeLessThanOrEqual(2);
    });
});

describe('the lead loop', () => {
    it('closes on headroom and settles at the target, without ringing', () => {
        const c = clock({ simRate: 60, rttSeconds: 0.05 });
        // Held at the target: the loop should not move.
        const before = c.targetLeadSeconds;
        settle(c, HEADROOM_TARGET, 20);
        expect(c.targetLeadSeconds).toBeCloseTo(before, 3);
    });

    it('raises the target when inputs arrive late, and lowers it when they arrive early', () => {
        const late = clock({ simRate: 60, rttSeconds: 0.05 });
        const lateBefore = late.targetLeadSeconds;
        settle(late, -3, 5);
        expect(late.targetLeadSeconds).toBeGreaterThan(lateBefore);

        const early = clock({ simRate: 60, rttSeconds: 0.15 });
        const earlyBefore = early.targetLeadSeconds;
        settle(early, HEADROOM_TARGET + 8, 5);
        expect(early.targetLeadSeconds).toBeLessThan(earlyBefore);
    });

    it('DOES NOT WIND UP: the outstanding correction stays bounded at a sustained deficit', () => {
        // The load-bearing property, stated as what `effectiveHeadroom` actually buys: the loop stops
        // re-commanding once enough is in flight, so (target − current) settles at a small equilibrium
        // instead of growing to the full range. Without the term the raw error is re-integrated every
        // ack and the gap opens immediately.
        const c = clock({ simRate: 60, rttSeconds: 0.05 });
        settle(c, -1, 200);
        const outstanding = (c.targetLeadSeconds - c.currentLeadSeconds) * 60;
        // Equilibrium is where `undelivered` cancels the deficit: HEADROOM_TARGET − (−1) = 3 ticks.
        expect(outstanding).toBeLessThan(6);
    });

    it('winds up WITHOUT the compensation term, which is what the term is for', () => {
        // The control, expressed through the same code: passing `leadAtSendTicks = targetLeadTicks`
        // asserts "everything commanded has been delivered", which zeroes `undelivered` and leaves the
        // raw error — the uncompensated loop.
        const raw = clock({ simRate: 60, rttSeconds: 0.05 });
        const compensated = clock({ simRate: 60, rttSeconds: 0.05 });
        for (let i = 0; i < 20; i++) {
            const compLead = compensated.currentLeadTicks;
            run(raw, 3);
            run(compensated, 3);
            raw.sample({ headroom: -1, leadAtSendTicks: raw.targetLeadSeconds * 60 });
            compensated.sample({ headroom: -1, leadAtSendTicks: compLead });
        }
        // 20 acks: uncompensated is already pinned; compensated is nowhere near.
        expect(raw.targetLeadSeconds).toBeCloseTo(LEAD_MAX_SECONDS, 6);
        expect(compensated.targetLeadSeconds).toBeLessThan(LEAD_MAX_SECONDS * 0.9);
    });

    it('settles at one-way + HEADROOM_TARGET when headroom responds to the lead, as a server measures it', () => {
        // The physical relation: a server measures `frame.tick - serverTickOnArrival`, and a frame
        // stamped `serverNow + lead` arriving at `serverNow + oneWay` yields `lead - oneWay`. So
        // headroom RESPONDS to the lead, and the loop has a reachable operating point — which the
        // fixed-headroom tests above deliberately deny it.
        const oneWayTicks = 6; // 100 ms at 60 Hz
        const c = clock({ simRate: 60, rttSeconds: 0.2 });
        for (let i = 0; i < 4000; i++) {
            const leadAtSend = c.currentLeadTicks;
            run(c, 3);
            c.sample({ headroom: leadAtSend - oneWayTicks, leadAtSendTicks: leadAtSend });
        }
        expect(c.currentLeadTicks).toBeCloseTo(oneWayTicks + HEADROOM_TARGET, 0);
        expect(c.targetLeadSeconds).toBeLessThan(LEAD_MAX_SECONDS);
    });

    it('measures the compensation AT SEND, so a round trip leaves no one-directional bias', () => {
        // A bias is only visible as a difference, so this is a comparison across two RTTs: with the
        // compensation read at send, the settling point does not depend on how long the ack took.
        const settleAt = (ackDelayFrames: number): number => {
            const c = clock({ simRate: 60, rttSeconds: 0.05 });
            const inFlight: Array<{ leadAtSendTicks: number; due: number }> = [];
            let now = 0;
            for (let frame = 0; frame < 600; frame++) {
                // A frame's worth of sending: stamp the lead as expressed NOW.
                inFlight.push({ leadAtSendTicks: c.currentLeadTicks, due: frame + ackDelayFrames });
                c.advance(now);
                now += 1 / 60;
                for (let i = inFlight.length - 1; i >= 0; i--) {
                    const entry = inFlight[i]!;
                    if (entry.due > frame) continue;
                    inFlight.splice(i, 1);
                    c.sample({ headroom: HEADROOM_TARGET, leadAtSendTicks: entry.leadAtSendTicks });
                }
            }
            return c.targetLeadSeconds;
        };
        // 300 ms of round trip at 60 Hz is 18 frames; zero RTT is the reference.
        expect(settleAt(18)).toBeCloseTo(settleAt(0), 3);
    });

    it('clamps the target into the legal range from either direction', () => {
        const low = clock({ simRate: 60, rttSeconds: 0.05 });
        settle(low, 1000, 50);
        expect(low.targetLeadSeconds).toBeCloseTo(1 / 60, 10);

        const high = clock({ simRate: 60, rttSeconds: 0.05 });
        for (let i = 0; i < 400; i++) high.sample({ headroom: -50, leadAtSendTicks: 0 });
        expect(high.targetLeadSeconds).toBeLessThanOrEqual(LEAD_MAX_SECONDS);
    });
});

describe('the nudge is the actuator, and only the rate', () => {
    it('does nothing while the error is under half a tick', () => {
        const c = clock({ simRate: 60, rttSeconds: 0.05 });
        expect(c.leadError).toBe(0);
        const before = c.currentLeadSeconds;
        run(c, 30);
        expect(c.currentLeadSeconds).toBeCloseTo(before, 12);
    });

    it('advances the counter beyond what the clock alone would produce, when raising the lead', () => {
        // Raising the target by 2 ticks advances the counter 2 ticks further over the same wall-clock,
        // and every index is still stamped exactly once, in order.
        const base = clock({ simRate: 60, rttSeconds: 0.05 });
        const nudged = clock({ simRate: 60, rttSeconds: 0.05 });
        nudged.sample({ headroom: HEADROOM_TARGET - 8, leadAtSendTicks: nudged.currentLeadTicks });
        expect(nudged.leadError).toBeGreaterThan(0);

        const baseTicks = run(base, 400);
        const nudgedTicks = run(nudged, 400);
        expect(nudgedTicks.length).toBeGreaterThan(baseTicks.length);
        expect(nudgedTicks).toEqual(nudgedTicks.toSorted((a, b) => a - b));
        expect(new Set(nudgedTicks).size).toBe(nudgedTicks.length);
    });

    it('scales the tick duration by at most NUDGE_MAX', () => {
        const c = clock({ simRate: 60, rttSeconds: 0.05 });
        c.sample({ headroom: -50, leadAtSendTicks: 0 }); // command a large correction
        const stamped = run(c, 600).length;
        const nominal = 600 / 1; // frames at 1/60 each, one tick per frame nominally
        // At most 2% faster than nominal, so the actuator's authority is bounded.
        expect(stamped).toBeLessThanOrEqual(Math.ceil(nominal * (1 + NUDGE_MAX * 1.5)));
    });

    it('reaches every target the loop can command, since the nudge walks the whole range', () => {
        const c = clock({ simRate: 60, rttSeconds: 0 });
        for (let i = 0; i < 400; i++) c.sample({ headroom: -50, leadAtSendTicks: 0 });
        expect(c.targetLeadSeconds).toBeCloseTo(LEAD_MAX_SECONDS, 6);
        // The whole range is LEAD_MAX − one tick ≈ 233 ms, delivered at 2% of each tick, so ~700 ticks
        // of nudging. Run well past that and it closes to within the deadband it stops inside — half a
        // tick, which is the resolution the counter has and the reason it stops there.
        run(c, 40000);
        expect(c.leadError).toBeLessThanOrEqual(0.5 / 60);
    });
});

describe('a suspended tab versus a slow path', () => {
    it('inverts localTick >= depictedTick under suspension while leadError reads ZERO', () => {
        const c = clock({ simRate: 60, snapshotTick: 0, rttSeconds: 0.05 });
        run(c, 60); // a second of ordinary play
        // The server ran 5 s while the tab slept; the client's dt clamp discarded it.
        const depicted = c.localTick + 300;
        expect(c.isBehind(depicted)).toBe(true);
        // And the actuator noticed nothing, which is exactly why the detector cannot be leadError.
        expect(c.leadError).toBeCloseTo(0, 6);
    });

    it('stays positive under a slow path with the lead pinned — headroom near −33 ticks', () => {
        // At RTT 800 ms the one-way trip is 24 ticks against a 15-tick cap, so headroom sits deeply
        // negative on a connection whose counter is as well positioned as the cap permits.
        const c = clock({ simRate: 60, snapshotTick: 0, rttSeconds: 0.8 });
        settle(c, -33, 50);
        expect(c.targetLeadSeconds).toBeLessThanOrEqual(LEAD_MAX_SECONDS);
        // depictedTick is stale by the downlink — 24 ticks — and the counter still leads it.
        const depicted = c.localTick - 24;
        expect(c.isBehind(depicted)).toBe(false);
    });

    it('is a sign test, so it needs no threshold to separate the two', () => {
        const c = clock({ simRate: 60, snapshotTick: 1000, rttSeconds: 0.05 });
        expect(c.isBehind(c.localTick)).toBe(false);
        expect(c.isBehind(c.localTick + 1)).toBe(true);
    });
});

describe('the epoch', () => {
    it('advances on demand, so post-stall samples are discardable by epoch', () => {
        const c = clock();
        expect(c.epoch).toBe(0);
        c.bumpEpoch();
        expect(c.epoch).toBe(1);
    });
});
