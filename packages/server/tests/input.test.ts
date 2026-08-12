// The input buffer, admission, and the phases (DESIGN §4, §8). Fixtures are compiled by the build.

import { afterEach, describe, expect, it } from 'vitest';
import { TopDownMovement, clearRuntime } from '@platform/core';
import { Dasher, Recorder, Rules } from '../dist/testkit/fixtures.js';
import {
    HORIZON_CLAMP_TICKS,
    INPUT_BUCKET_FRAMES,
    RATE_BREACH_CLOSE,
    futureHorizonTicks,
    holdStaleTicks,
    maxSeqGap,
    pastGraceTicks,
} from '../src/constants.js';
import { harness } from './harness.js';
import type { Harness } from './harness.js';

afterEach(() => {
    clearRuntime();
});

/** Attaches a script to a player's avatar and returns the live instance. */
function onAvatar<T>(h: Harness, playerId: string, klass: new () => object, name: string): T {
    const avatar = h.server.runtime.playerManager?.byId(playerId)?.avatar;
    avatar?.addScript(klass as never);
    const host = `entity:${avatar?.entityId as unknown as number}`;
    return [...h.server.runtime.instances.forHost(host)].find((i) => i.className === name)
        ?.instance as T;
}

function recorderOn(h: Harness, playerId: string): Recorder {
    return onAvatar<Recorder>(h, playerId, Recorder as never, 'Recorder');
}

describe('§4.3 check 1 — identity comes from the connection', () => {
    it('applies a frame to conn.player regardless of what the frame claims', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const first = h.joined('a');
        const second = h.joined('b');
        const one = recorderOn(h, 'c1');
        const two = recorderOn(h, 'c2');

        // A frame carrying another player's id — the field does not exist on the wire, and a
        // hostile client adding one must change nothing.
        expect(second.welcome).toBeDefined();
        first.input(h.tick + 1, [{ action: 'jump', on: 'press' }]);
        h.pumpTicks(3);

        expect(one.presses).toBe(1);
        expect(two.presses).toBe(0);
    });
});

describe('§4.3 check 2 — the tick window', () => {
    it('applies an in-window frame on exactly the tick it names', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        const rec = recorderOn(h, 'c1');
        const target = h.tick + 4;

        peer.input(target, [{ action: 'jump', on: 'press' }]);
        h.pumpTicks(1); // delivered, buffered, not yet due
        expect(rec.presses).toBe(0);
        while (h.tick < target) h.pumpTicks(1);
        expect(rec.presses).toBe(1);
    });

    it('refuses a frame older than PAST_GRACE and one well past the horizon', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        const rec = recorderOn(h, 'c1');
        h.pumpTicks(40);
        const grace = pastGraceTicks(60);
        const horizon = futureHorizonTicks(60);

        peer.input(h.tick - grace - 5, [{ action: 'jump', on: 'press' }]);
        peer.input(h.tick + horizon + HORIZON_CLAMP_TICKS + 5, [{ action: 'jump', on: 'press' }]);
        h.pumpTicks(6);
        expect(rec.presses).toBe(0);
    });

    it('clamps a frame just past the horizon rather than refusing it', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        const rec = recorderOn(h, 'c1');
        const horizon = futureHorizonTicks(60);
        const at = h.tick + horizon + HORIZON_CLAMP_TICKS;

        peer.input(at, [{ action: 'jump', on: 'press' }]);
        // Clamped to the horizon, so it lands EARLIER than the tick it named.
        h.pumpTicks(horizon + 1);
        expect(rec.presses).toBe(1);
    });

    it('applies a past-grace frame late rather than never — merge-forward', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        const rec = recorderOn(h, 'c1');
        h.pumpTicks(30);

        // Names a tick already stepped: inside the grace, so admissible, and drainThrough applies
        // it on the next stepped tick instead of leaving it in the map forever.
        peer.input(h.tick - 3, [{ action: 'jump', on: 'press' }]);
        h.pumpTicks(2);
        expect(rec.presses).toBe(1);
    });
});

describe('§4.3 check 3 — the rate ceiling', () => {
    it('refuses the excess and leaves other connections untouched', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const noisy = h.joined('a');
        const quiet = h.joined('b');
        const one = recorderOn(h, 'c1');
        const two = recorderOn(h, 'c2');

        const flood = INPUT_BUCKET_FRAMES + 12;
        for (let i = 0; i < flood; i++) {
            noisy.input(h.tick + 1, [{ action: 'jump', on: 'press' }]);
        }
        quiet.input(h.tick + 1, [{ action: 'jump', on: 'press' }]);
        h.pumpTicks(3);

        // The bucket bounds what reaches the dispatcher; the quiet peer is unaffected.
        expect(one.presses).toBeLessThanOrEqual(INPUT_BUCKET_FRAMES + 2);
        expect(one.presses).toBeGreaterThan(0);
        expect(two.presses).toBe(1);
    });
});

describe('§4.4 — ackSeq is the highest contiguous RESOLVED seq', () => {
    it('a refusal resolves its seq, so the ack advances past it', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        h.pumpTicks(30);

        // seq 0 is refused as too-old; seq 1 applies. An ack that waited for 0 to APPLY would wait
        // forever, and the client's ring would never prune past it.
        peer.input(h.tick - pastGraceTicks(60) - 5, [{ action: 'jump', on: 'press' }]);
        peer.input(h.tick + 1, [{ action: 'jump', on: 'press' }]);
        peer.clear();
        h.pumpTicks(8);

        expect(peer.lastState?.ackSeq).toBe(1);
    });

    it('a seq that never arrived holds the ack back, then is abandoned', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        h.pumpTicks(4);

        peer.skipSeq(1); // seq 0 is never sent
        peer.input(h.tick + 1, [{ action: 'jump', on: 'press' }]); // seq 1
        peer.input(h.tick + 2, [{ action: 'jump', on: 'press' }]); // seq 2
        peer.clear();
        h.pumpTicks(6);

        // CONTIGUOUS, not a high-water mark: 1 and 2 resolved, but 0 is unaccounted for.
        expect(peer.lastState?.ackSeq).toBe(-1);

        // Datable by the tick of the next seq that DID arrive, so once that tick leaves the past
        // grace the gap is abandoned and the frontier is released.
        peer.clear();
        h.pumpTicks(pastGraceTicks(60) + 6);
        expect(peer.lastState?.ackSeq).toBe(2);
    });

    it('does not ack a buffered frame before the tick it names is stepped', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        const target = h.tick + 12;
        peer.input(target, [{ action: 'jump', on: 'press' }]);
        peer.clear();
        h.pumpTicks(4);

        // Received and buffered, NOT applied: an ack here would let the client prune the input it
        // would need to replay.
        expect(peer.lastState?.ackSeq).toBe(-1);
        h.pumpTicks(14);
        expect(peer.lastState?.ackSeq).toBe(0);
    });

    it('reports earliestHeadroom for the earliest input the ack resolved, and omits it when quiet', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        h.pumpTicks(4);

        const lead = 5;
        peer.input(h.tick + lead, [{ action: 'jump', on: 'press' }]);
        peer.clear();
        h.pumpTicks(10);

        const acked = peer.states.find((s) => s.ackSeq === 0);
        // frame.tick - serverTickOnArrival, signed, measured by the server at admission. The frame
        // is delivered by the next wake's `deliver()`, which runs BEFORE that wake's step — so the
        // server's tick on arrival is still the tick the frame was addressed from.
        expect(acked?.earliestHeadroom).toBe(lead);

        peer.clear();
        h.pumpTicks(6);
        const quiet = peer.lastState;
        expect(quiet?.ackSeq).toBe(0);
        expect(quiet && 'earliestHeadroom' in quiet).toBe(false);
    });

    it('nothing admitted is ever silently unapplied', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        const rec = recorderOn(h, 'c1');
        h.pumpTicks(30);

        // A mix: in-window, past-grace, and one refused outright.
        const seqs = [
            peer.input(h.tick + 2, [{ action: 'jump', on: 'press' }]),
            peer.input(h.tick - 2, [{ action: 'jump', on: 'release' }]),
            peer.input(h.tick - pastGraceTicks(60) - 9, [{ action: 'jump', on: 'press' }]),
            peer.input(h.tick + 3, [{ action: 'jump', on: 'press' }]),
        ];
        peer.clear();
        h.pumpTicks(12);

        // Every seq is settled — applied or definitively rejected — so the frontier passed all four.
        expect(peer.lastState?.ackSeq).toBe(Math.max(...seqs));
        expect(rec.presses + rec.releases).toBeGreaterThan(0);
    });

    it('refuses a replayed seq rather than re-firing an edge the loop walked past', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        const rec = recorderOn(h, 'c1');
        h.settle([peer]);

        const seq = peer.input(h.tick + 2, [{ action: 'jump', on: 'press' }]);
        h.pumpTicks(8);
        expect(rec.presses).toBe(1);
        expect(peer.lastState?.ackSeq).toBe(seq);

        // Already resolved, so no ack could report it either way — applying it again would double-fire.
        peer.inputAt(seq, h.tick + 2, [{ action: 'jump', on: 'press' }]);
        h.pumpTicks(8);
        expect(rec.presses).toBe(1);
        expect(peer.lastState?.ackSeq).toBe(seq);
    });

    it('refuses a seq further ahead than the window could ever apply', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        h.settle([peer]);

        // One frame per tick is the wire's ceiling, so a seq past the window names a tick that is
        // already unapplicable — and dating that gap would cost a map entry per missing seq.
        peer.inputAt(maxSeqGap(60) + 1, h.tick + 2, [{ action: 'jump', on: 'press' }]);
        h.pumpTicks(8);

        expect(peer.lastState?.ackSeq).toBe(-1);
        // Refused before `noteArrival`, so it dated no gap and moved no arrival bound.
        expect(h.server.connections[0]?.admission.highestSeen).toBe(-1);
    });
});

describe('§4.2 — the phases, synthesized from edges alone', () => {
    it('fires hold every tick while held, and only the declared phase', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        const rec = recorderOn(h, 'c1');
        const dash = onAvatar<Dasher>(h, 'c1', Dasher as never, 'Dasher');

        peer.input(h.tick + 2, [{ action: 'jump', on: 'press' }]);
        h.pumpTicks(4);
        const settled = rec.holds;
        expect(settled).toBeGreaterThan(0);
        h.pumpTicks(20);

        expect(rec.presses).toBe(1);
        expect(rec.releases).toBe(0);
        // ONE hold per stepped tick while held, and the press handler exactly once. Before the
        // dispatcher matched phases at all, one press fired all three handlers on this action.
        expect(rec.holds).toBe(settled + 20);
        expect(dash.dashes).toBe(0);
    });

    it('a release ends the holds and fires the release handler once', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        const rec = recorderOn(h, 'c1');

        peer.input(h.tick + 2, [{ action: 'jump', on: 'press' }]);
        h.pumpTicks(6);
        const held = rec.holds;
        expect(held).toBeGreaterThan(0);

        peer.input(h.tick + 2, [{ action: 'jump', on: 'release' }]);
        h.pumpTicks(6);
        expect(rec.releases).toBe(1);
        const after = rec.holds;
        h.pumpTicks(6);
        expect(rec.holds).toBe(after);
    });

    it('an axis value persists across ticks with no further sample', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        const rec = recorderOn(h, 'c1');

        peer.input(h.tick + 2, [{ action: 'jump', on: 'press', value: 0.75 }]);
        h.pumpTicks(10);
        expect(rec.lastValue).toBe(0.75);

        // A hold SAMPLE updates the axis and dispatches nothing of its own — the per-tick hold is
        // synthesized, so dispatching the sample too would double-fire it.
        peer.input(h.tick + 2, [{ action: 'jump', on: 'hold', value: 0.25 }]);
        h.pumpTicks(4);
        expect(rec.lastValue).toBe(0.25);
        const before = rec.holds;
        h.pumpTicks(6);
        expect(rec.holds).toBe(before + 6);
    });

    it('one frame carries every action for its tick and advances seq by one', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        const rec = recorderOn(h, 'c1');

        const seq = peer.input(h.tick + 2, [
            { action: 'jump', on: 'press' },
            { action: 'moveX', on: 'hold', value: 1 },
            { action: 'moveY', on: 'hold', value: -1 },
        ]);
        expect(seq).toBe(0);
        peer.clear();
        h.pumpTicks(8);
        expect(rec.presses).toBe(1);
        expect(peer.lastState?.ackSeq).toBe(0);
    });

    it('fills movement intent from the panel-mapped move axes', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        const player = h.server.runtime.playerManager?.byId('c1');
        player?.setMovement(TopDownMovement as never);

        peer.input(h.tick + 2, [{ action: 'moveX', on: 'hold', value: 1 }]);
        h.pumpTicks(6);
        expect(player?.movement?.intent.x).toBe(1);
    });

    it('releases a held action after HOLD_STALE_TICKS of silence', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        const rec = recorderOn(h, 'c1');

        peer.input(h.tick + 2, [{ action: 'jump', on: 'press' }]);
        h.pumpTicks(4);
        expect(rec.releases).toBe(0);

        // The crash case no client blur handler can cover: no release is ever sent, so without this
        // the synthesized hold fires forever on an avatar running into a wall.
        h.pumpTicks(holdStaleTicks(60) + 2);
        expect(rec.releases).toBe(1);
        const settled = rec.holds;
        h.pumpTicks(10);
        expect(rec.holds).toBe(settled);
    });
});

describe('§4.3 — an input frame before the join is refused', () => {
    it('has no player to attribute to, so it changes nothing', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.connect();
        peer.input(5, [{ action: 'jump', on: 'press' }]);
        h.pumpTicks(3);
        expect(h.server.runtime.playerManager?.players).toHaveLength(0);
        expect(peer.received).toStrictEqual([]);
    });
});

describe('§7 — a sustained rate breach closes that connection alone', () => {
    it('closes the flooder and leaves the others applying input', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const noisy = h.joined('a');
        const quiet = h.joined('b');
        const two = recorderOn(h, 'c2');

        // Well past the bucket AND past the cumulative refusal ceiling — a burst is absorbed, a
        // sustained flood is not.
        for (let i = 0; i < INPUT_BUCKET_FRAMES + RATE_BREACH_CLOSE + 8; i++) {
            noisy.input(h.tick + 1, [{ action: 'jump', on: 'press' }]);
        }
        h.pumpTicks(4);
        expect(h.server.connections.map((c) => c.connectionId)).toStrictEqual(['c2']);

        quiet.input(h.tick + 1, [{ action: 'jump', on: 'press' }]);
        h.pumpTicks(4);
        expect(two.presses).toBeGreaterThan(0);
    });
});
