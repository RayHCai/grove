// Prediction: the rewind that makes a delta land on authoritative state, the replay that carries the
// local player's own entities forward over it, and the correction the display eases rather than snaps.

import { afterEach, describe, expect, it } from 'vitest';
import { clearRuntime, entityKey } from '@platform/core';
import type { EntityId } from '@platform/core';
import { createReadyNullRenderer } from '@platform/renderer/null';
import type { IRenderer, NodePatch } from '@platform/renderer';
import type {
    InputFrame,
    NetId,
    StateDiff,
    StateEnvelope,
    WireStructuralOp,
} from '@platform/protocol';
import { loopbackPair } from '@platform/transport';
import { RenderBridge } from '../src/bridge.js';
import { GameClient } from '../src/client.js';
import { CORRECTION_SMOOTH_SECONDS, MAX_REPLAY_TICKS } from '../src/constants.js';
import { ManualFrameSource, ScriptedInputDevice } from '../src/input.js';
import { Mirror } from '../src/mirror.js';
import { Prediction } from '../src/prediction.js';
import { InputRing } from '../src/ring.js';
// Compiled by the build (src/testkit/fixtures.ts); this file carries no decorator syntax.
import { Slider } from '../dist/testkit/fixtures.js';
import { FakeServer, entity, transformDiff, wireTransform } from './fake-server.js';

const BOUNDS = { left: -400, right: 400, top: 300, bottom: -300 };
const PLAYER = 'p1';
const SPEED = Slider.speed;
const SEND_RATE = 20;

interface Harness {
    mirror: Mirror;
    bridge: RenderBridge;
    ring: InputRing;
    prediction: Prediction;
    renderer: IRenderer;
    batches: NodePatch[][];
    /** Applies an authoritative envelope the way `GameClient` does: rewind, apply, replay. */
    receive(envelope: StateEnvelope, localTick: number): void;
    /** One frame with no authoritative traffic. */
    step(localTick: number): void;
    send(tick: number, seq: number, actions: InputFrame['actions']): void;
    local(netId: number): EntityId;
    posX(netId: number): number;
    drawnX(netId: number): number;
}

function stateEnvelope(
    structural: WireStructuralOp[] = [],
    tick = 1,
    state: StateDiff[] = [],
): StateEnvelope {
    return { kind: 'state', tick, ackSeq: -1, structural, state };
}

async function harness(): Promise<Harness> {
    const renderer = await createReadyNullRenderer({ design: { width: 800, height: 600 } });
    const batches: NodePatch[][] = [];
    const realUpdate = renderer.updateNodes.bind(renderer);
    renderer.updateNodes = (patches: readonly NodePatch[]): void => {
        batches.push([...patches]);
        realUpdate(patches);
    };

    const mirror = new Mirror({ simRate: 60, bounds: BOUNDS, regions: [] });
    const bridge = new RenderBridge(renderer, mirror.view(), SEND_RATE);
    const ring = new InputRing();
    const prediction = new Prediction({ mirror, ring, bridge, playerId: PLAYER });
    mirror.simulate(prediction.context);
    // Exactly what `GameClient` wires: without it the buffer would interpolate the very entities this
    // suite predicts, and every correction assertion below would read a blended pose instead.
    bridge.setPredicted(prediction.scope);

    // The roster the input pass resolves the local player through — the wire's own player-join op.
    mirror.applyState(
        stateEnvelope([{ kind: 'player-join', player: { id: PLAYER, index: 0, name: 'Ray' } }], 0),
    );

    let seq = 0;
    const h: Harness = {
        mirror,
        bridge,
        ring,
        prediction,
        renderer,
        batches,
        receive(envelope, localTick): void {
            prediction.rewind();
            bridge.reconcile(mirror.applyState(envelope));
            prediction.advance(localTick, true);
        },
        step(localTick): void {
            prediction.advance(localTick, false);
        },
        send(tick, _seq, actions): void {
            ring.push({ kind: 'input', tick, seq: seq++, actions }, 0, 0);
        },
        local(netId): EntityId {
            const id = mirror.index.local(netId as NetId);
            if (id === undefined) throw new Error(`no local handle for netId ${netId}`);
            return id;
        },
        posX(netId): number {
            return mirror.runtime.transforms.posX(h.local(netId));
        },
        drawnX(netId): number {
            return h.posX(netId) + bridge.correctionOf(h.local(netId)).x;
        },
    };
    return h;
}

/**
 * Spawns an entity owned by `owner` and attaches the one script this suite simulates.
 *
 * Rewinds first, exactly as the client's drain does: the entity table restores whole even under a
 * scoped baseline, so an authoritative spawn applied over a predicted world is undone by the next one.
 */
function spawnSlider(h: Harness, netId: number, owner: string | null, posX = 0): EntityId {
    h.prediction.rewind();
    h.bridge.reconcile(
        h.mirror.applyState(
            stateEnvelope(
                [
                    {
                        kind: 'spawn',
                        snapshot: entity(netId, 'slider', {
                            owner,
                            transform: wireTransform({ posX }),
                        }),
                    },
                ],
                1,
            ),
        ),
    );
    const local = h.local(netId);
    h.mirror.runtime.wiring?.attachToEntity(local, Slider as never);
    return local;
}

/** Holds `right` from `from` to `to` inclusive, one frame per tick, as the flush path would. */
function hold(h: Harness, from: number, to: number): void {
    h.send(from, 0, [{ action: 'right', on: 'press' }]);
    for (let tick = from + 1; tick <= to; tick++) h.send(tick, 0, []);
}

afterEach(() => clearRuntime());

describe('an idle mirror simulates nothing', () => {
    it('steps to a no-op until passes are installed', async () => {
        const h = await harness();
        spawnSlider(h, 1, PLAYER);
        h.mirror.simulate(null);
        h.send(2, 0, [{ action: 'right', on: 'press' }]);

        h.receive(stateEnvelope([], 2), 4);

        expect(h.posX(1)).toBe(0);
    });
});

describe('the depicted tick stays the server’s', () => {
    it('does not move when the predicted world runs ahead of it', async () => {
        const h = await harness();
        spawnSlider(h, 1, PLAYER);
        hold(h, 2, 5);

        h.receive(stateEnvelope([], 2), 5);

        expect(h.mirror.depictedTick).toBe(2);
        expect(h.prediction.predictedTick).toBe(5);
        // The runtime itself believes the local tick, which is what a replayed handler must read.
        expect(h.mirror.runtime.tick).toBe(5);
    });
});

describe('the replay carries the local player’s own entities', () => {
    it('applies a held action once per replayed tick', async () => {
        const h = await harness();
        spawnSlider(h, 1, PLAYER);
        hold(h, 2, 5);

        h.receive(stateEnvelope([], 1), 5);

        // Ticks 2..5 — the press tick plus three held ticks, each owed a synthesized hold.
        expect(h.posX(1)).toBe(4 * SPEED);
    });

    it('leaves an entity owned by someone else where the server put it', async () => {
        const h = await harness();
        spawnSlider(h, 1, PLAYER);
        spawnSlider(h, 2, 'p2');
        hold(h, 2, 4);

        h.receive(stateEnvelope([], 1), 4);

        expect(h.posX(1)).toBeGreaterThan(0);
        expect(h.posX(2)).toBe(0);
    });

    it('carries forward one tick at a time when no envelope arrived', async () => {
        const h = await harness();
        spawnSlider(h, 1, PLAYER);
        hold(h, 2, 4);
        h.receive(stateEnvelope([], 1), 2);
        const afterFirst = h.posX(1);

        h.send(3, 0, []);
        h.step(3);
        h.send(4, 0, []);
        h.step(4);

        expect(h.posX(1)).toBe(afterFirst + 2 * SPEED);
    });
});

describe('the rewind takes the predicted world back', () => {
    it('restores the authoritative pose exactly', async () => {
        const h = await harness();
        spawnSlider(h, 1, PLAYER);
        hold(h, 2, 6);
        h.receive(stateEnvelope([], 1), 6);
        expect(h.posX(1)).toBeGreaterThan(0);

        h.prediction.rewind();

        expect(h.posX(1)).toBe(0);
        expect(h.mirror.runtime.tick).toBe(1);
    });

    it('rolls back @serverState a predicted tick wrote', async () => {
        const h = await harness();
        const local = spawnSlider(h, 1, PLAYER);
        hold(h, 2, 4);
        h.receive(stateEnvelope([], 1), 4);
        const values = h.mirror.runtime.hosts.get(entityKey(local as number))?.record.values;
        expect(values?.get('steps')).toBeGreaterThan(0);

        h.prediction.rewind();

        expect(values?.get('steps')).toBe(0);
    });

    it('discards poses from a rewind whose replay never ran', async () => {
        const h = await harness();
        spawnSlider(h, 1, PLAYER);
        hold(h, 2, 4);
        h.receive(stateEnvelope([], 1), 4);
        expect(h.posX(1)).toBe(3 * SPEED);

        // A rewind with no advance behind it — what the client does on any frame it is not `live`.
        h.prediction.rewind();

        // The authority then moves the entity while nothing at all is predicted.
        h.mirror.applyTransforms({
            kind: 'transform',
            tick: 2,
            transform: [transformDiff(1, { posX: 50 })],
        });
        h.receive(stateEnvelope([], 2), 2);

        // Measured against the abandoned poses this would read as a 20-unit disagreement and ease from
        // a position nobody was ever shown.
        expect(h.posX(1)).toBe(50);
        expect(h.bridge.correctionOf(h.local(1)).remaining).toBe(0);
    });

    it('marks the rewound slots dirty, so the renderer is told the pose it drew is gone', async () => {
        const h = await harness();
        spawnSlider(h, 1, PLAYER);
        hold(h, 2, 4);
        h.receive(stateEnvelope([], 1), 4);
        h.bridge.pushTransforms(0);
        h.batches.length = 0;

        h.prediction.rewind();
        h.bridge.pushTransforms(1 / 60);

        expect(h.batches.flat()).toHaveLength(1);
    });
});

describe('a delta lands on authoritative state, not on a predicted pose', () => {
    it('does not compound the server’s answer with the prediction it replaces', async () => {
        const h = await harness();
        spawnSlider(h, 1, PLAYER);
        hold(h, 2, 3);
        h.receive(stateEnvelope([], 1), 3);
        const predicted = h.posX(1);
        expect(predicted).toBe(2 * SPEED);

        // The server simulated tick 2 itself and says the entity is at 100 — a hard disagreement.
        h.mirror.applyTransforms({
            kind: 'transform',
            tick: 2,
            transform: [transformDiff(1, { posX: 100 })],
        });
        h.receive(stateEnvelope([], 2), 3);

        // Tick 3 alone is left to replay over the server's own answer.
        expect(h.posX(1)).toBe(100 + SPEED);
    });

    it('converges when the server never mentions the entity again', async () => {
        const h = await harness();
        spawnSlider(h, 1, PLAYER);
        hold(h, 2, 3);
        h.receive(stateEnvelope([], 1), 3);

        // Nothing about entity 1 in this envelope: an apply over a predicted pose would keep the
        // predicted value and drift forever.
        h.mirror.applyTransforms({
            kind: 'transform',
            tick: 2,
            transform: [transformDiff(1, { posX: 0 })],
        });
        h.receive(stateEnvelope([], 2), 3);
        h.receive(stateEnvelope([], 3), 3);

        expect(h.posX(1)).toBe(0);
    });
});

describe('a correction is eased on screen and exact in the simulation', () => {
    it('draws where the player was looking, then decays to the server’s answer', async () => {
        const h = await harness();
        spawnSlider(h, 1, PLAYER);
        hold(h, 2, 3);
        h.receive(stateEnvelope([], 1), 3);
        const drawnBefore = h.posX(1);

        h.mirror.applyTransforms({
            kind: 'transform',
            tick: 2,
            transform: [transformDiff(1, { posX: 5 })],
        });
        h.receive(stateEnvelope([], 2), 3);

        // The simulation took the server's answer; the screen still shows the old pose.
        expect(h.posX(1)).toBe(5 + SPEED);
        expect(h.drawnX(1)).toBeCloseTo(drawnBefore, 6);

        h.bridge.pushTransforms(0);
        h.bridge.pushTransforms(CORRECTION_SMOOTH_SECONDS / 2);
        expect(h.drawnX(1)).toBeGreaterThan(h.posX(1));

        h.bridge.pushTransforms(CORRECTION_SMOOTH_SECONDS * 2);
        expect(h.drawnX(1)).toBe(h.posX(1));
    });

    it('stays continuous when a second correction lands mid-ease', async () => {
        const h = await harness();
        spawnSlider(h, 1, PLAYER);
        hold(h, 2, 3);
        h.receive(stateEnvelope([], 1), 3);

        h.mirror.applyTransforms({
            kind: 'transform',
            tick: 2,
            transform: [transformDiff(1, { posX: 5 })],
        });
        h.receive(stateEnvelope([], 2), 3);
        h.bridge.pushTransforms(0);
        h.bridge.pushTransforms(CORRECTION_SMOOTH_SECONDS / 2);
        const midEase = h.drawnX(1);

        // A second disagreement while the first is still half-drawn. The offset replaces rather than
        // accumulates, so the residual has to be inside the measurement or the screen jumps by it.
        h.mirror.applyTransforms({
            kind: 'transform',
            tick: 3,
            transform: [transformDiff(1, { posX: 1 })],
        });
        h.receive(stateEnvelope([], 3), 4);

        expect(h.drawnX(1)).toBeCloseTo(midEase, 6);
    });

    it('shows a correction past the snap distance at once, dropping an ease in flight', async () => {
        const h = await harness();
        spawnSlider(h, 1, PLAYER);
        hold(h, 2, 3);
        h.receive(stateEnvelope([], 1), 3);

        // A small disagreement first, so there is a live ease for the snap to have to drop.
        h.mirror.applyTransforms({
            kind: 'transform',
            tick: 2,
            transform: [transformDiff(1, { posX: 5 })],
        });
        h.receive(stateEnvelope([], 2), 3);
        h.bridge.pushTransforms(0);
        h.bridge.pushTransforms(CORRECTION_SMOOTH_SECONDS / 2);
        expect(h.bridge.correctionOf(h.local(1)).remaining).toBeGreaterThan(0);

        h.mirror.applyTransforms({
            kind: 'transform',
            tick: 3,
            transform: [transformDiff(1, { posX: 5000 })],
        });
        h.receive(stateEnvelope([], 3), 4);

        expect(h.prediction.counters.snappedCorrections).toBe(1);
        expect(h.bridge.correctionOf(h.local(1)).remaining).toBe(0);
        expect(h.drawnX(1)).toBe(h.posX(1));
    });

    it('holds a corrected entity in the batch while it eases, though nothing moved', async () => {
        const h = await harness();
        spawnSlider(h, 1, PLAYER);
        hold(h, 2, 3);
        h.receive(stateEnvelope([], 1), 3);
        h.mirror.applyTransforms({
            kind: 'transform',
            tick: 2,
            transform: [transformDiff(1, { posX: 5 })],
        });
        h.receive(stateEnvelope([], 2), 3);
        h.bridge.pushTransforms(0);
        h.batches.length = 0;

        // No simulation, no dirty slot — only the ease is left.
        h.bridge.pushTransforms(CORRECTION_SMOOTH_SECONDS / 4);

        expect(h.batches.flat()).toHaveLength(1);
    });
});

describe('an axis is owed a hold too', () => {
    it('synthesizes one per tick for a non-neutral axis, which never enters `held`', async () => {
        const h = await harness();
        spawnSlider(h, 1, PLAYER);
        // A `hold` sample, the shape an axis reaches the wire as: it updates the axis and is owed a
        // dispatch per tick, but it is not a press and never enters `heldActions()`.
        h.send(2, 0, [{ action: 'right', on: 'hold', value: 0.5 }]);
        h.send(3, 0, []);

        h.receive(stateEnvelope([], 1), 3);

        expect(h.posX(1)).toBe(2 * SPEED);
    });

    it('dispatches a sampled hold exactly once, never twice', async () => {
        const h = await harness();
        spawnSlider(h, 1, PLAYER);
        h.send(2, 0, [{ action: 'right', on: 'hold', value: 0.5 }]);

        h.receive(stateEnvelope([], 1), 2);

        // One tick, one dispatch: applying the frame's own hold as well would double-fire it.
        expect(h.posX(1)).toBe(SPEED);
    });

    it('carries a non-neutral axis through the horizon once its frame is acked', async () => {
        const h = await harness();
        spawnSlider(h, 1, PLAYER);
        h.send(2, 0, [{ action: 'right', on: 'hold', value: 0.5 }]);
        // Acked, so the frame folds into the horizon and the replay can no longer read it.
        h.ring.ack(0);
        expect(h.ring.size).toBe(0);

        h.receive(stateEnvelope([], 2), 4);

        expect(h.posX(1)).toBe(2 * SPEED);
    });
});

describe('the replay is bounded', () => {
    it('caps a span longer than the ring rather than re-running all of it', async () => {
        const h = await harness();
        spawnSlider(h, 1, PLAYER);
        hold(h, 2, 3);

        h.receive(stateEnvelope([], 1), MAX_REPLAY_TICKS * 3);

        expect(h.prediction.counters.cappedReplays).toBe(1);
        expect(h.prediction.counters.steppedTicks).toBe(MAX_REPLAY_TICKS);
        expect(h.prediction.predictedTick).toBe(MAX_REPLAY_TICKS * 3);
    });
});

describe('a whole session predicts', () => {
    /** A real `GameClient` over a real loopback, so the frame order is the one under test. */
    async function session(): Promise<{
        client: GameClient;
        server: FakeServer;
        run(n?: number): void;
        runSilent(n?: number): void;
        avatar(): EntityId;
    }> {
        const pair = loopbackPair({ latency: 1 });
        const server = new FakeServer(pair.server, {
            entities: [entity(1, 'slider', { owner: PLAYER })],
        });
        const renderer = await createReadyNullRenderer({ design: { width: 800, height: 600 } });
        const frames = new ManualFrameSource();
        const device = new ScriptedInputDevice();
        let now = 0;

        const client = new GameClient({
            transport: pair.client,
            renderer,
            frames,
            device,
            clock: { nowSeconds: () => now },
            name: 'Ray',
            bindings: [{ kind: 'button', code: 'keys:KeyD', action: 'right' }],
            pump: () => pair.deliver(),
            predict: true,
        });
        client.start();

        const h = {
            client,
            server,
            run(n = 1): void {
                for (let i = 0; i < n; i++) {
                    now += 1 / 60;
                    server.tick++;
                    if (server.welcomed && server.tick % 3 === 0) server.ackAll();
                    frames.frame(now);
                }
            },
            runSilent(n = 1): void {
                for (let i = 0; i < n; i++) {
                    now += 1 / 60;
                    server.tick++;
                    frames.frame(now);
                }
            },
            avatar(): EntityId {
                const local = client.mirror?.index.local(1 as NetId);
                if (local === undefined) throw new Error('no avatar');
                return local;
            },
        };
        for (let i = 0; i < 20 && client.state !== 'live'; i++) h.run(1);
        // The wire names a script class this runtime cannot resolve, so the suite attaches it.
        client.mirror?.runtime.wiring?.attachToEntity(h.avatar(), Slider as never);
        device.emit({ kind: 'key', code: 'keys:KeyD', down: true });
        return h;
    }

    it('runs the local avatar exactly as far ahead as the client is ahead of the server', async () => {
        const h = await session();
        const rt = h.client.mirror!.runtime;

        // Sampled every frame rather than once: the gap sawtooths, closing to nothing on the frame an
        // envelope lands naming the tick the counter is already on — and the invariant holds there too.
        let sawALead = false;
        for (let i = 0; i < 12; i++) {
            h.run(1);
            const stats = h.client.stats();
            const lead = stats.localTick - stats.depictedTick;
            expect(stats.predictedTick).toBe(stats.localTick);
            expect(rt.transforms.posX(h.avatar())).toBe(lead * SPEED);
            sawALead ||= lead > 0;
        }

        expect(sawALead).toBe(true);
        expect(h.client.stats().resimulations).toBeGreaterThan(0);
    });

    it('rewinds for a transform envelope, not only for a state envelope', async () => {
        const h = await session();
        const rt = h.client.mirror!.runtime;
        h.run(6);
        const before = h.client.stats();

        // A transform envelope for a tick already described, so it writes on arrival rather than being
        // held. Arriving over a predicted pose it would otherwise stomp it with a stale authority.
        h.server.sendTransforms([transformDiff(1, { posX: 250 })], before.depictedTick);
        h.run(1);

        const stats = h.client.stats();
        expect(stats.resimulations).toBeGreaterThan(before.resimulations);
        // The server's own answer, plus exactly the replayed span — never the predicted pose plus it.
        expect(rt.transforms.posX(h.avatar())).toBe(
            250 + (stats.localTick - stats.depictedTick) * SPEED,
        );
    });

    it('stops while stalled, so a refused input cannot become ghost gameplay', async () => {
        const h = await session();
        h.run(10);
        const rt = h.client.mirror!.runtime;

        // A drought long enough to raise `stalled`, with the key still held down.
        h.runSilent(70);
        expect(h.client.state).toBe('stalled');
        const frozen = rt.transforms.posX(h.avatar());
        h.runSilent(10);

        expect(rt.transforms.posX(h.avatar())).toBe(frozen);
    });

    it('resumes from the authority on recovery, not from a pose measured before the stall', async () => {
        const h = await session();
        h.run(10);
        const rt = h.client.mirror!.runtime;

        h.runSilent(70);
        expect(h.client.state).toBe('stalled');
        // Recovery is not one frame: the ack clock froze during the drought too, so the session
        // flip-flops until an ack lands and moves it.
        for (let i = 0; i < 10 && h.client.state !== 'live'; i++) h.run(4);
        h.run(8);

        expect(h.client.state).toBe('live');
        const stats = h.client.stats();
        expect(rt.transforms.posX(h.avatar())).toBe((stats.localTick - stats.depictedTick) * SPEED);
        // The rewind on the recovery's first frame recorded poses no replay consumed. Measured against
        // them, the drought's worth of prediction reads as a correction and the avatar snaps.
        expect(h.client.prediction?.counters.snappedCorrections).toBe(0);
    });
});

describe('the scope follows ownership', () => {
    it('picks up an entity the server hands the local player mid-session', async () => {
        const h = await harness();
        spawnSlider(h, 1, 'p2');
        h.receive(stateEnvelope([], 1), 1);
        expect(h.prediction.scope.size).toBe(0);

        spawnSlider(h, 2, PLAYER);
        hold(h, 2, 3);
        h.receive(stateEnvelope([], 1), 3);

        expect(h.prediction.scope.size).toBe(1);
        expect(h.posX(2)).toBe(2 * SPEED);
    });
});
