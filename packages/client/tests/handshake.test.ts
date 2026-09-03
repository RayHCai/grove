// The handshake and the session, end to end: a real `GameClient` over a real
// `loopbackPair` against the `FakeServer`, with no wall-clock, no socket and no canvas.

import { afterEach, describe, expect, it } from 'vitest';
import { clearRuntime } from '@platform/core';
import { defined } from '@platform/math';
import { createReadyNullRenderer } from '@platform/renderer/null';
import type { IRenderer } from '@platform/renderer';
import { loopbackPair } from '@platform/transport';
import type { LoopbackPair } from '@platform/transport';
import { PROTOCOL_VERSION } from '@platform/protocol';
import { assetId } from '@platform/project';
import { GameClient } from '../src/client.js';
import {
    ACK_STALL_TICKS,
    BUNDLE_DEADLINE_SECONDS,
    JOIN_DEADLINE_SECONDS,
    MAX_WIRE_ITEMS,
    RING_TICKS,
} from '../src/constants.js';
import type { Binding } from '../src/bindings.js';
import type { BundleSource } from '../src/bundle.js';
import type { ClientProject } from '../src/handshake.js';
import { ManualFrameSource, ScriptedInputDevice } from '../src/input.js';
import { FakeServer, entity, netId, transformDiff } from './fake-server.js';
import type { FakeServerOptions } from './fake-server.js';

const TICK = 1 / 60;

/** Yields a macrotask, so a resolved fetch and anything queued on a timer both continue. */
function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A `BundleSource` whose fetch a test opens by hand.
 *
 * Gated rather than immediate, because the whole point of the pre-live state is what happens WHILE
 * the fetch is outstanding — a source that resolved at once would never exercise it.
 */
class ScriptedBundle {
    readonly fetched: string[] = [];
    evaluated = 0;
    readonly #bytes: ArrayBuffer;
    readonly #digest: string;
    readonly #gate: Promise<void>;
    #open!: () => void;

    constructor(digest: string, byteLength = 8) {
        this.#digest = digest;
        this.#bytes = new ArrayBuffer(byteLength);
        this.#gate = new Promise<void>((resolve) => {
            this.#open = resolve;
        });
    }

    /** Answers the outstanding fetch. */
    release(): void {
        this.#open();
    }

    source(): BundleSource {
        return {
            fetch: async (url: string): Promise<ArrayBuffer> => {
                this.fetched.push(url);
                await this.#gate;
                return this.#bytes;
            },
            hash: (): Promise<string> => Promise.resolve(this.#digest),
            evaluate: (): Promise<unknown> => {
                this.evaluated += 1;
                return Promise.resolve({});
            },
        };
    }
}

interface Harness {
    client: GameClient;
    server: FakeServer;
    frames: ManualFrameSource;
    device: ScriptedInputDevice;
    renderer: IRenderer;
    pair: LoopbackPair;
    /**
     * Runs `n` display frames, advancing the scripted clock and the server's tick one each, and
     * BROADCASTING a state envelope every send-tick at the server's own tick — which is what the real
     * server does unconditionally.
     *
     * Both are load-bearing for these tests. An envelope carrying a tick AHEAD of the client's counter
     * correctly trips the behind-check and resyncs, so a harness that invented tick numbers would test
     * the resync path everywhere by accident; and a harness that sent nothing would reach `stalled`
     * after a second, which refuses input.
     */
    run(n?: number): void;
    /** Frames with NO server traffic, for the drought that raises `stalled`. */
    runSilent(n?: number): void;
    /**
     * Frames where the server broadcasts but NEVER acks — the connection is evidently alive while the
     * ring only grows, which is what separates occupancy from evidence about the connection.
     */
    runSilentWithTraffic(n?: number): void;
    /** Delivers in-flight frames without advancing anything — loopback is one deliver() late. */
    flush(): void;
    now(): number;
}

async function harness(
    opts: FakeServerOptions = {},
    clientOpts: {
        bindings?: readonly Binding[];
        latency?: number;
        start?: boolean;
        project?: ClientProject;
        bundle?: BundleSource;
    } = {},
): Promise<Harness> {
    const pair = loopbackPair({ latency: clientOpts.latency ?? 1 });
    const server = new FakeServer(pair.server, opts);
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
        bindings: clientOpts.bindings ?? [],
        pump: () => pair.deliver(),
        ...defined({ project: clientOpts.project, bundle: clientOpts.bundle }),
    });

    const simRate = opts.simRate ?? 60;
    const everySendTick = Math.round(simRate / (opts.sendRate ?? 20));
    // The server ticks at ITS OWN simRate, not once per display frame: at 20 Hz against a 60 fps frame
    // source that is every third frame. A peer that ticked per frame would run 3× the rate it declared,
    // outpacing the client's counter by construction and resyncing forever — a harness artifact that
    // looks exactly like a clock bug.
    let frameCount = 0;
    const serverFramesPerTick = Math.round(60 / simRate);
    const advanceServer = (): boolean => {
        frameCount++;
        if (frameCount % serverFramesPerTick !== 0) return false;
        server.tick++;
        return true;
    };

    const h: Harness = {
        client,
        server,
        frames,
        device,
        renderer,
        pair,
        now: () => now,
        run(n = 1): void {
            for (let i = 0; i < n; i++) {
                now += TICK;
                const ticked = advanceServer();
                // The server broadcasts on its send cadence, acking whatever input arrived — the
                // ordinary traffic the stall triggers are fed by.
                if (ticked && server.welcomed && server.tick % everySendTick === 0) server.ackAll();
                frames.frame(now);
            }
        },
        runSilent(n = 1): void {
            for (let i = 0; i < n; i++) {
                now += TICK;
                advanceServer();
                frames.frame(now);
            }
        },
        runSilentWithTraffic(n = 1): void {
            for (let i = 0; i < n; i++) {
                now += TICK;
                const ticked = advanceServer();
                if (ticked && server.welcomed && server.tick % everySendTick === 0) {
                    server.sendState();
                }
                frames.frame(now);
            }
        },
        flush(): void {
            pair.deliver();
        },
    };
    if (clientOpts.start !== false) client.start();
    return h;
}

/** Drives frames until the session is `live`, or throws — so a test never asserts on a half-join. */
function untilLive(h: Harness, limit = 20): void {
    for (let i = 0; i < limit && h.client.state !== 'live'; i++) h.run(1);
}

afterEach(() => clearRuntime());

describe('the join sequence', () => {
    it('sends a JoinRequest as the FIRST frame', async () => {
        const h = await harness();
        h.run(1);
        expect(h.server.received[0]?.kind).toBe('join-request');
        expect(h.server.joins).toEqual([{ name: 'Ray', protocolVersion: PROTOCOL_VERSION }]);
    });

    it('registers handlers before sending, so the welcome is never lost to wiring order', async () => {
        // Asserted rather than assumed: transport retains frames for a handler that has not registered,
        // and the join path must not depend on that rule for ordering the client controls.
        const h = await harness();
        h.run(3);
        expect(h.client.state).toBe('live');
    });

    it('accepts no envelope and sends no input before the Welcome', async () => {
        const h = await harness(
            { reject: 'full' },
            { bindings: [{ kind: 'button', code: 'keys:KeyW', action: 'jump' }] },
        );
        h.device.emit({ kind: 'key', code: 'keys:KeyW', down: true });
        h.run(3);
        expect(h.server.inputs).toHaveLength(0);
        expect(h.client.mirror).toBeUndefined();
    });

    it('reaches `live` with the clock seeded from snapshot.tick', async () => {
        const h = await harness({ snapshotTick: 900 });
        untilLive(h);
        expect(h.client.state).toBe('live');
        // The tick the counter seeds from and the tick its initial world describes cannot disagree, so
        // the mirror is at the server's tick and the counter LEADS it — the only sound statement.
        expect(h.client.mirror!.depictedTick).toBeGreaterThanOrEqual(900);
        expect(h.client.stats().localTick).toBeGreaterThanOrEqual(h.client.mirror!.depictedTick);
    });

    it('applies the join snapshot through the one path', async () => {
        const h = await harness({
            snapshotTick: 10,
            entities: [entity(1, 'wall'), entity(2, 'coin')],
            players: [
                { id: 'p1', index: 0, name: 'Ray' },
                { id: 'p2', index: 1, name: 'Other' },
            ],
            state: [{ host: { kind: 'game' }, fields: { timeLeft: 30 } }],
        });
        h.run(3);
        expect(h.client.mirror?.index.size).toBe(2);
        expect(h.client.mirror?.runtime.playerManager?.players).toHaveLength(2);
        expect(h.client.mirror?.runtime.hosts.ensure('game').record.values.get('timeLeft')).toBe(
            30,
        );
        expect(h.client.localPlayer?.id).toBe('p1');
        expect(h.client.stats().nodeCount).toBe(2);
    });

    it('fails a join the server never answers, rather than waiting for the life of the tab', async () => {
        // The server closes an unjoined connection on its own deadline; with no symmetric one here a
        // peer that accepts the socket and says nothing leaves a spinner up forever.
        const h = await harness({ ignoreJoin: true });
        h.runSilent(3);
        expect(h.client.state).toBe('connecting');

        h.runSilent(Math.ceil(JOIN_DEADLINE_SECONDS / TICK) + 2);
        expect(h.client.state).toBe('failed');
        expect(h.client.lifecycle.failure?.kind).toBe('peer');
    });

    it('measures a NON-ZERO lead in loopback, so the lead loop executes in local mode', async () => {
        // Loopback delivers server→client one tick late by construction, so a local run has real
        // latency, a real lead, and every line of the lead loop executes in a single-player playtest.
        const h = await harness();
        h.run(4);
        expect(h.client.stats().rttSeconds).toBeGreaterThan(0);
        expect(h.client.stats().currentLeadSeconds).toBeGreaterThan(0);
    });
});

describe('a snapshot too big for one frame', () => {
    it('reassembles the chunks ahead of the welcome and joins on the whole world', async () => {
        const h = await harness({
            snapshotTick: 10,
            entities: [entity(1, 'wall'), entity(2, 'coin'), entity(3, 'wall'), entity(4, 'coin')],
            snapshotChunks: 2,
        });
        untilLive(h);

        expect(h.client.state).toBe('live');
        // Every entity, from both the chunks and the welcome's own remainder — the session opens on
        // one world, and chunking is invisible past the fold.
        expect(h.client.mirror?.index.size).toBe(4);
        expect(h.client.stats().nodeCount).toBe(4);
    });

    it('refuses a short set rather than opening a session on a partial world', async () => {
        const h = await harness({
            snapshotTick: 10,
            entities: [entity(1, 'wall'), entity(2, 'coin')],
            snapshotChunks: 2,
            understateChunkCount: true,
        });
        h.run(3);

        // A world missing entities the server believes it sent reads later as a mirror bug rather than
        // as the truncated join it is, so it fails here and names the peer.
        expect(h.client.state).toBe('failed');
        expect(h.client.lifecycle.failure?.kind).toBe('peer');
        expect(h.client.mirror).toBeUndefined();
    });

    it('refuses a set past the byte budget, which the count cap alone does not bound', async () => {
        // A chunk may be megabytes, so a cap on how MANY are held bounds no memory at all: the set
        // below is well inside the count and a gigabyte-scale peer would be too.
        const blob = 'x'.repeat(1024 * 1024);
        const h = await harness({
            snapshotTick: 10,
            entities: Array.from({ length: 20 }, (_, i) =>
                entity(i + 1, 'wall', { tags: [blob] as never }),
            ),
            snapshotChunks: 20,
        });
        h.run(3);

        expect(h.client.stats().snapshotChunksDropped).toBeGreaterThan(0);
        // And what is left no longer adds up to the count the `Welcome` names, so the join is refused
        // rather than opening a session on the half of the world that fitted.
        expect(h.client.state).toBe('failed');
        expect(h.client.lifecycle.failure?.kind).toBe('peer');
    });

    it('leaves an unchunked welcome exactly as it was', async () => {
        const h = await harness({ snapshotTick: 10, entities: [entity(1, 'wall')] });
        untilLive(h);

        expect(h.client.state).toBe('live');
        expect(h.server.welcome?.snapshotChunks).toBeUndefined();
        expect(h.client.mirror?.index.size).toBe(1);
    });
});

describe('the script bundle is verified before it is run', () => {
    const named = { url: '/bundle.js', hash: 'digest-1' };

    it('declares the project on the join request, so the server can refuse a wrong build', async () => {
        const project: ClientProject = {
            projectId: 'arcade',
            projectHash: 'build-7',
            bundleHash: '',
        };
        const h = await harness({ project }, { project });
        h.run(2);
        expect(h.server.received[0]).toMatchObject({
            kind: 'join-request',
            projectId: 'arcade',
            projectHash: 'build-7',
            bundleHash: '',
        });
    });

    it('holds the session pre-live while the bundle is in flight, and goes live after it', async () => {
        const bundle = new ScriptedBundle(named.hash);
        const h = await harness({ bundle: named }, { bundle: bundle.source() });
        h.run(2);

        expect(h.client.state).toBe('loading');
        expect(h.client.mirror).toBeUndefined();
        expect(bundle.fetched).toEqual(['/bundle.js']);

        bundle.release();
        await settle();

        expect(h.client.state).toBe('live');
        expect(bundle.evaluated).toBe(1);
        expect(h.client.mirror).toBeDefined();
    });

    it('applies the envelopes that arrived during the fetch, in order, once the session opens', async () => {
        const bundle = new ScriptedBundle(named.hash);
        const h = await harness({ bundle: named }, { bundle: bundle.source() });
        h.run(2);
        expect(h.client.state).toBe('loading');

        // At the snapshot's own tick, so the held envelope does not read as the server having run
        // ahead of a counter that has not been seeded yet.
        const tick = h.server.welcome!.snapshot.tick;
        h.server.sendState([{ kind: 'spawn', snapshot: entity(7, 'held') }], [], { tick });
        h.runSilent(1);
        // Held, not dropped and not applied: there is no mirror for it to land in yet.
        expect(h.client.mirror).toBeUndefined();

        bundle.release();
        await settle();
        h.runSilent(1);

        expect(h.client.state).toBe('live');
        expect(h.client.mirror?.index.local(netId(7))).toBeDefined();
    });

    it('fails without evaluating when the bytes do not match the hash the server sent', async () => {
        const bundle = new ScriptedBundle('some-other-digest');
        const h = await harness({ bundle: named }, { bundle: bundle.source() });
        h.run(2);
        bundle.release();
        await settle();

        expect(h.client.state).toBe('failed');
        expect(h.client.lifecycle.failure?.kind).toBe('bundle');
        // The whole mechanism: a bundle that failed the comparison is never handed to `evaluate`.
        expect(bundle.evaluated).toBe(0);
        expect(h.client.mirror).toBeUndefined();
    });

    it('refuses a bundle url whose scheme this client did not choose, and fetches nothing', async () => {
        const bundle = new ScriptedBundle(named.hash);
        const h = await harness(
            { bundle: { url: 'data:text/javascript,globalThis.x=1', hash: named.hash } },
            { bundle: bundle.source() },
        );
        h.run(2);
        await settle();

        expect(h.client.state).toBe('failed');
        expect(h.client.lifecycle.failure?.kind).toBe('bundle');
        expect(bundle.fetched).toEqual([]);
    });

    it('fails rather than going live when the server names code and no loader was supplied', async () => {
        const h = await harness({ bundle: named });
        h.run(2);
        expect(h.client.state).toBe('failed');
        expect(h.client.lifecycle.failure?.kind).toBe('bundle');
    });

    it('skips the fetch when this client already holds those bytes, and says so on the join', async () => {
        const bundle = new ScriptedBundle(named.hash);
        const project: ClientProject = {
            projectId: '',
            projectHash: '',
            bundleHash: named.hash,
        };
        const h = await harness({ bundle: named }, { bundle: bundle.source(), project });
        h.run(2);

        expect(h.client.state).toBe('live');
        expect(bundle.fetched).toEqual([]);
        expect(h.server.received[0]).toMatchObject({ bundleHash: named.hash });
    });

    it('does not open a session on a socket that closed while the bundle was in flight', async () => {
        // The load resolves into a session that no longer exists: opening it would go `live` on a
        // frozen frame source, with no failure text and nothing to correct the world it shows.
        const bundle = new ScriptedBundle(named.hash);
        const h = await harness({ bundle: named }, { bundle: bundle.source() });
        h.run(2);
        expect(h.client.state).toBe('loading');

        h.server.close();
        h.run(2);
        expect(h.client.state).toBe('disconnected');

        bundle.release();
        await settle();

        expect(h.client.state).toBe('disconnected');
        expect(h.client.mirror).toBeUndefined();
    });

    it('fails as `peer` when the welcome’s world throws after the load, not wedging in `loading`', async () => {
        // The same malformed snapshot fails cleanly through the drain's catch; arriving down the load
        // path it escapes into a promise, and the session sits in `loading` with nothing left to end it.
        const bundle = new ScriptedBundle(named.hash);
        const h = await harness(
            { bundle: named, entities: [{ netId: 9, template: 'x' } as never] },
            { bundle: bundle.source() },
        );
        h.run(2);
        expect(h.client.state).toBe('loading');

        bundle.release();
        await settle();

        expect(h.client.state).toBe('failed');
        expect(h.client.lifecycle.failure?.kind).toBe('peer');
    });

    it('fails a fetch that never answers, rather than holding envelopes for the tab’s lifetime', async () => {
        const bundle = new ScriptedBundle(named.hash);
        const h = await harness({ bundle: named }, { bundle: bundle.source() });
        h.run(2);
        expect(h.client.state).toBe('loading');

        h.runSilent(Math.ceil(BUNDLE_DEADLINE_SECONDS / TICK) + 1);
        expect(h.client.state).toBe('failed');
        expect(h.client.lifecycle.failure?.kind).toBe('bundle');
    });
});

describe('a template first used mid-session draws with its real visual', () => {
    it('merges a manifest envelope into a session that joined before it existed', async () => {
        const h = await harness();
        untilLive(h);
        // Nothing in the welcome — this client joined before the template came into use.
        expect(h.client.stats().nodeCount).toBe(0);

        h.server.sendRaw({
            kind: 'manifest',
            visuals: {
                assets: [{ key: 'gem.png', kind: 'texture', url: '/gem.png' }],
                templates: [{ template: 'gem', kind: 'group' }],
            },
        });
        h.run(1);
        // The spawn rides directly behind it, which is the ordering the server guarantees.
        h.server.sendState([{ kind: 'spawn', snapshot: entity(3, 'gem') }]);
        h.run(2);

        expect(h.client.mirror!.index.local(netId(3))).toBeDefined();
        const nodes = [...h.renderer.inspect().nodes.values()];
        expect(nodes).toHaveLength(1);
        // A group, not the sprite placeholder a template the client never heard of falls back to.
        expect(nodes[0]?.kind).toBe('group');
        expect(h.client.stats().assetLoadFailed).toBe(0);
    });

    it('drops an unusable manifest envelope without ending the session', async () => {
        const h = await harness();
        untilLive(h);
        h.server.sendRaw({ kind: 'manifest', visuals: { assets: 'not an array' } });
        h.run(2);
        expect(h.client.state).toBe('live');
    });
});

describe('a refusal is distinguishable from a drop', () => {
    it('reaches `failed` with a version reason, and builds no mirror', async () => {
        const h = await harness({ reject: 'version' });
        h.run(3);
        expect(h.client.state).toBe('failed');
        const failure = h.client.lifecycle.failure;
        expect(failure?.kind).toBe('rejected');
        // "update the game" rather than "try again" — which is what serverProtocolVersion buys.
        expect(failure).toMatchObject({ serverProtocolVersion: PROTOCOL_VERSION });
        expect(failure && 'reason' in failure && failure.reason).toContain('update');
        expect(h.client.mirror).toBeUndefined();
    });

    it('reaches `failed` with a capacity reason, phrased as capacity and not as a network error', async () => {
        const h = await harness({ reject: 'full' });
        h.run(3);
        expect(h.client.state).toBe('failed');
        const failure = h.client.lifecycle.failure;
        expect(failure && 'reason' in failure && failure.reason).toBe('This game is full.');
    });

    it('stays `failed` when the close arrives after the reject, rather than becoming disconnected', async () => {
        const h = await harness({ reject: 'full' });
        h.run(5);
        expect(h.client.state).toBe('failed');
    });

    it('treats an undecodable Welcome as terminal, and distinctly from a Reject', async () => {
        const h = await harness({ malformedWelcome: true });
        h.run(3);
        expect(h.client.state).toBe('failed');
        expect(h.client.lifecycle.failure?.kind).toBe('undecodable');
    });

    it('closes the transport on failure, so the peer cannot keep filling an inbox nothing drains', async () => {
        // A failed session stops its frame source, and nothing drains the inbox after that: left
        // connected, every later envelope the peer sends is memory held for the life of the tab.
        const h = await harness();
        untilLive(h);
        h.server.sendRaw({
            kind: 'state',
            tick: h.server.tick,
            ackSeq: 0,
            structural: [{ kind: 'spawn', snapshot: { netId: 9, template: 'x' } }],
            state: [],
        });
        h.run(2);
        expect(h.client.state).toBe('failed');

        // The frame source is stopped, so the close crosses on a bare deliver rather than on a frame.
        h.flush();
        expect(h.server.closed).toBe(true);
    });

    it('reaches `disconnected` on a bare close and stops the frame source', async () => {
        const h = await harness();
        h.run(3);
        expect(h.client.state).toBe('live');
        h.server.close();
        h.run(2);
        expect(h.client.state).toBe('disconnected');
        // The frame source is stopped, so driving it further does nothing.
        const at = h.client.stats().localTick;
        h.run(5);
        expect(h.client.stats().localTick).toBe(at);
    });
});

describe('the steady state', () => {
    it('applies envelopes in arrival order and creates then destroys exactly one node', async () => {
        const h = await harness();
        untilLive(h);
        // Both in ONE deliver(), so the client drains them as a batch in arrival order.
        h.server.sendState([{ kind: 'spawn', snapshot: entity(1) }]);
        h.server.tick++;
        h.server.sendState([{ kind: 'destroy', netId: 1 as never }]);
        h.run(2);
        expect(h.client.stats().nodeCount).toBe(0);
        expect(h.client.mirror!.index.size).toBe(0);
    });

    it('holds a transform envelope until its tick’s state envelope lands', async () => {
        const h = await harness();
        untilLive(h);
        h.server.sendState([{ kind: 'spawn', snapshot: entity(1) }]);
        h.run(2);
        const local = h.client.mirror!.index.local(1 as never)!;

        // The transform arrives BEFORE its counterpart — the WebTransport case, where the two ride
        // different streams and FIFO no longer orders them. The server's clock is NOT touched by hand:
        // in loopback the client's lead is only a tick or two, so a hand-advanced server tick eats it
        // and correctly trips the behind-check, which would test the resync path instead of the hold.
        h.server.sendTransforms([transformDiff(1, { posX: 42 })], h.server.tick + 1);
        h.runSilent(1);
        // Held, not applied: the join key is an equality, so it waits for its counterpart.
        expect(h.client.mirror!.runtime.transforms.posX(local)).toBe(0);

        // The next ordinary broadcast covers that tick and releases it.
        h.run(6);
        // Lands at the TRANSFORM's position rather than the spawn's, pinning it against initSlot.
        expect(h.client.mirror!.runtime.transforms.posX(local)).toBe(42);
    });

    it('stays `live` and counts an unknown netId', async () => {
        const h = await harness();
        untilLive(h);
        h.server.sendState([{ kind: 'destroy', netId: 4242 as never }]);
        h.run(2);
        expect(h.client.state).toBe('live');
        expect(h.client.stats().unknownNetId).toBe(1);
    });

    it('refreshes the clock sync on the interval, and the reply is diagnostic', async () => {
        const h = await harness();
        untilLive(h);
        expect(h.server.timeSyncs).toHaveLength(0);
        h.run(180); // past SYNC_INTERVAL_SECONDS at 60 fps
        expect(h.server.timeSyncs.length).toBeGreaterThan(0);
        expect(h.client.stats().rttSeconds).toBeGreaterThan(0);
    });
});

describe('input on the wire', () => {
    it('sends one frame per tick, with seq and tick advancing together', async () => {
        const h = await harness(
            {},
            { bindings: [{ kind: 'button', code: 'keys:KeyW', action: 'jump' }] },
        );
        untilLive(h);
        h.device.emit({ kind: 'key', code: 'keys:KeyW', down: true });
        h.run(1);
        h.device.emit({ kind: 'key', code: 'keys:KeyW', down: false });
        h.run(1);
        h.flush(); // loopback is one deliver() late, so the last frame is still in flight

        expect(h.server.inputs).toHaveLength(2);
        const [press, release] = h.server.inputs;
        expect(press?.frame.actions).toEqual([{ action: 'jump', on: 'press' }]);
        expect(release?.frame.actions).toEqual([{ action: 'jump', on: 'release' }]);
        // seq and tick advance together, which is what makes `ackSeq` name a tick boundary.
        expect(release!.frame.seq).toBe(press!.frame.seq + 1);
        expect(release!.frame.tick).toBeGreaterThan(press!.frame.tick);
    });

    it('sends nothing for a held key across many frames', async () => {
        const h = await harness(
            {},
            { bindings: [{ kind: 'button', code: 'keys:KeyW', action: 'jump' }] },
        );
        untilLive(h);
        h.device.emit({ kind: 'key', code: 'keys:KeyW', down: true });
        h.run(30);
        expect(h.server.inputs).toHaveLength(1);
    });

    it('sends no empty frames', async () => {
        const h = await harness(
            {},
            { bindings: [{ kind: 'button', code: 'keys:KeyW', action: 'jump' }] },
        );
        h.run(30);
        expect(h.server.inputs).toHaveLength(0);
    });

    it('coalesces two device events for one action in one tick', async () => {
        const h = await harness(
            {},
            { bindings: [{ kind: 'axis', code: 'gamepad:x', action: 'moveX' }] },
        );
        untilLive(h);
        h.device.emit({ kind: 'axis', code: 'gamepad:x', value: 0.5 });
        h.device.emit({ kind: 'axis', code: 'gamepad:x', value: 0.9 });
        h.run(1);
        h.flush();
        expect(h.server.inputs).toHaveLength(1);
        expect(h.server.inputs[0]?.frame.actions).toHaveLength(1);
        expect(h.server.inputs[0]?.frame.actions[0]?.value).toBe(0.9);
    });

    it('prunes the ring at the ack and steers the lead off the headroom sample', async () => {
        const h = await harness(
            {},
            { bindings: [{ kind: 'button', code: 'keys:KeyW', action: 'jump' }] },
        );
        untilLive(h);
        h.device.emit({ kind: 'key', code: 'keys:KeyW', down: true });
        h.run(1);
        h.flush();
        expect(h.client.ring.size).toBe(1);

        h.run(4); // the next send-tick acks it
        expect(h.client.ring.size).toBe(0);
        // And the edge folded into the horizon on the way out.
        expect(h.client.ring.heldAtHorizon.held('jump')).toBe(true);
    });

    it('flushes synthetic releases IMMEDIATELY, in the same handler and with no frame between', async () => {
        const h = await harness(
            {},
            {
                bindings: [
                    { kind: 'button', code: 'keys:KeyA', action: 'left' },
                    { kind: 'button', code: 'keys:KeyD', action: 'right' },
                    { kind: 'button', code: 'keys:Space', action: 'jump' },
                ],
            },
        );
        h.run(3);
        for (const code of ['keys:KeyA', 'keys:KeyD', 'keys:Space']) {
            h.device.emit({ kind: 'key', code, down: true });
        }
        h.run(1);
        h.flush(); // the presses are delivered, so `before` counts them
        const before = h.server.inputs.length;

        // No frame tick in between: the releases must reach the ring in this very call.
        h.device.emit({ kind: 'focusLost' });
        expect(h.client.ring.size).toBeGreaterThan(0);
        h.flush();
        expect(h.server.inputs.length).toBe(before + 1);
        const released = h.server.inputs.at(-1)!.frame.actions;
        expect(released).toHaveLength(3);
        expect(released.every((a) => a.on === 'release')).toBe(true);
    });
});

describe('stalling refuses input', () => {
    it('reaches `stalled` after a drought and refuses input, then recovers on the next envelope', async () => {
        const h = await harness(
            {},
            { bindings: [{ kind: 'button', code: 'keys:KeyW', action: 'jump' }] },
        );
        untilLive(h);
        expect(h.client.state).toBe('live');

        h.runSilent(70); // over a second with no envelope at all
        expect(h.client.state).toBe('stalled');

        const before = h.server.inputs.length;
        h.device.emit({ kind: 'key', code: 'keys:KeyW', down: true });
        h.runSilent(1);
        h.flush();
        expect(h.server.inputs.length).toBe(before);

        // Recovery is the next ordinary envelope, at the server's own (now much later) tick — so the
        // the behind-check trips too, and the session recovers through a resync rather than straight to
        // `live`. That is the designed response to a counter that has fallen behind.
        h.run(4);
        expect(['live', 'resyncing']).toContain(h.client.state);
        untilLive(h, 40);
        expect(h.client.state).toBe('live');
    });

    it('sends a synthetic release EVEN WHILE STALLED — it can only end ghost gameplay', async () => {
        const h = await harness(
            {},
            { bindings: [{ kind: 'button', code: 'keys:KeyW', action: 'jump' }] },
        );
        untilLive(h);
        h.device.emit({ kind: 'key', code: 'keys:KeyW', down: true });
        h.run(1);
        h.flush();
        const before = h.server.inputs.length;

        h.runSilent(70);
        expect(h.client.state).toBe('stalled');

        h.device.emit({ kind: 'focusLost' });
        h.flush();
        expect(h.server.inputs.length).toBe(before + 1);
        expect(h.server.inputs.at(-1)?.frame.actions[0]?.on).toBe('release');
    });

    it('does not stall on ring occupancy alone', async () => {
        // Overflow is a fact about local burst rate; wiring it here would let an energetic player
        // disable their own controls.
        const h = await harness(
            {},
            { bindings: [{ kind: 'axis', code: 'gamepad:x', action: 'moveX' }] },
        );
        untilLive(h);
        // A burst filling the ring past capacity, with the server still broadcasting but never acking.
        // Occupancy alone must not refuse input; only ACK STARVATION does, and that is asserted
        // separately below with the deadline actually elapsed.
        for (let i = 0; i < RING_TICKS + 10; i++) {
            h.device.emit({
                kind: 'axis',
                code: 'gamepad:x',
                value: (i % 2 === 0 ? 1 : -1) * (0.5 + i / 400),
            });
            h.runSilentWithTraffic();
        }
        expect(h.client.ring.droppedToOverflow).toBeGreaterThan(0);
        expect(h.client.state).toBe('live');
    });

    it('ACK STARVATION is what stalls, asserted separately from overflow', async () => {
        const h = await harness(
            {},
            { bindings: [{ kind: 'axis', code: 'gamepad:x', action: 'moveX' }] },
        );
        untilLive(h);
        // One unacked frame, then well past ACK_STALL_TICKS of live traffic that never acks it.
        h.device.emit({ kind: 'axis', code: 'gamepad:x', value: 1 });
        h.runSilentWithTraffic(1);
        expect(h.client.ring.size).toBeGreaterThan(0);
        // Live traffic throughout, so the drought trigger cannot be what fires; only the frozen ack can.
        h.runSilentWithTraffic(ACK_STALL_TICKS + 10);
        expect(h.client.state).toBe('stalled');
    });

    it('does NOT recover from ack starvation on traffic that did not advance the ack', async () => {
        // The server sending is not evidence that it is PROCESSING. Recovering here would accept input
        // again into a ring nothing drains, in a world that is still frozen.
        const h = await harness(
            {},
            { bindings: [{ kind: 'axis', code: 'gamepad:x', action: 'moveX' }] },
        );
        untilLive(h);
        h.device.emit({ kind: 'axis', code: 'gamepad:x', value: 1 });
        h.runSilentWithTraffic(ACK_STALL_TICKS + 10);
        expect(h.client.state).toBe('stalled');

        // More broadcasts, still no ack: still stalled.
        h.runSilentWithTraffic(20);
        expect(h.client.state).toBe('stalled');

        // The ack itself is what recovers it.
        h.server.ackAll();
        h.run(2);
        expect(h.client.state).toBe('live');
    });

    it('counts the ack deadline in TICKS, so a fast display does not stall a slow sim early', async () => {
        // A frame-counting deadline fires 3× early at 20 Hz — the tick-versus-frame unit confusion, in
        // the one place it decides whether controls go dead.
        const h = await harness(
            { simRate: 20, sendRate: 20 },
            { bindings: [{ kind: 'axis', code: 'gamepad:x', action: 'moveX' }] },
        );
        untilLive(h);
        h.device.emit({ kind: 'axis', code: 'gamepad:x', value: 1 });
        // At simRate 20 against a 60 fps frame source the counter advances every third frame, so the
        // edge is not stamped until one has elapsed.
        h.runSilentWithTraffic(4);
        expect(h.client.ring.size).toBeGreaterThan(0);

        // ACK_STALL_TICKS of a 20 Hz sim is 3 s — far longer than the same count of 60 fps frames, so a
        // frame-counting implementation is already stalled here.
        h.runSilentWithTraffic(ACK_STALL_TICKS + 5);
        expect(h.client.state).toBe('live');

        // And it does stall once the deadline in the SESSION's ticks has actually elapsed.
        h.runSilentWithTraffic(60 * 3);
        expect(h.client.state).toBe('stalled');
    });
});

describe('resync', () => {
    it('resyncs when the counter falls behind the depicted tick, and leaves nothing behind', async () => {
        const h = await harness({ snapshotTick: 0 });
        untilLive(h);
        h.server.sendState([{ kind: 'spawn', snapshot: entity(1) }]);
        h.run(2);
        expect(h.client.mirror!.index.size).toBe(1);

        // The server ran far ahead while the tab slept: the first envelope after resume inverts the
        // invariant, and the response is a resync rather than a counter repair.
        h.server.tick += 100_000;
        h.server.sendState([]);
        h.run(2);

        // Re-runs the join, so a fresh Welcome and a fresh snapshot land through the one path.
        expect(h.server.joins).toHaveLength(2);
        untilLive(h, 40);
        expect(h.client.state).toBe('live');
        // Ring empty, mirror re-applied, no orphaned node or map entry from the abandoned world.
        expect(h.client.ring.size).toBe(0);
        expect(h.client.mirror!.index.size).toBe(0);
        expect(h.client.stats().nodeCount).toBe(0);
    });

    it('treats a rate change as a resync trigger rather than a live retune', async () => {
        const h = await harness({ simRate: 60 });
        untilLive(h);
        h.server.sendRateChange(20);
        h.run(2);
        expect(h.server.joins).toHaveLength(2);
    });

    it('does NOT resync a healthy session, where the lead is only a tick or two', async () => {
        // The invariant is checked once per frame AFTER the counter advances, not inside apply: in
        // loopback the lead is structurally ~2 ticks, so a check at drain time — before this frame's own
        // tick is credited — reads one tick short on ordinary accumulator phase drift and resyncs a
        // connection that is working perfectly. Measured: it fired within the first ten frames.
        const h = await harness({ snapshotTick: 0 });
        untilLive(h);
        h.run(300); // five seconds of ordinary play
        expect(h.client.state).toBe('live');
        // One join, so no resync happened at any point.
        expect(h.server.joins).toHaveLength(1);
        // And the invariant genuinely holds throughout, rather than being unchecked.
        expect(h.client.stats().localTick).toBeGreaterThanOrEqual(h.client.mirror!.depictedTick);
    });

    it('does not resync at 20 Hz either, where the one-tick lead floor has least room', async () => {
        // The thinnest margin in the system: `LEAD_MIN` is one tick whatever a tick is worth, and at
        // 20 Hz the counter advances only every third display frame — so any phase-drift sensitivity in
        // the invariant check shows up here first.
        const h = await harness({ simRate: 20, sendRate: 20, snapshotTick: 0 });
        untilLive(h, 40);
        h.run(300);
        expect(h.client.state).toBe('live');
        expect(h.server.joins).toHaveLength(1);
    });

    it('holds the invariant across a slow link, where both terms degrade together', async () => {
        // Latency-independent: under a slow path `depictedTick` is stale by the downlink, which is the
        // same delay the headroom deficit reflects — so a sign test needs no threshold.
        const h = await harness({ snapshotTick: 0 }, { latency: 8 });
        untilLive(h, 60);
        h.run(300);
        expect(h.client.state).toBe('live');
        expect(h.server.joins).toHaveLength(1);
    });

    it('re-asserts what the player is holding, since the new session holds nothing', async () => {
        // The server's fresh session has no record of the press, and edges-only means no later event
        // would ever mention it: the avatar would stand still with the key down until it is released.
        const h = await harness(
            { snapshotTick: 0 },
            { bindings: [{ kind: 'button', code: 'keys:KeyW', action: 'jump' }] },
        );
        untilLive(h);
        h.device.emit({ kind: 'key', code: 'keys:KeyW', down: true });
        h.run(2);
        expect(h.client.actions.held('jump')).toBe(true);

        h.server.tick += 100_000;
        h.server.sendState([]);
        h.run(2);
        untilLive(h, 40);
        const before = h.server.inputs.length;
        h.run(4);

        const presses = h.server.inputs
            .slice(before)
            .flatMap((i) => i.frame.actions)
            .filter((a) => a.action === 'jump' && a.on === 'press');
        expect(presses).toHaveLength(1);
    });

    it('does not re-press after a stall, where the same session still holds it', async () => {
        // A second press on a live session dispatches a spurious edge to a handler.
        const h = await harness(
            {},
            { bindings: [{ kind: 'button', code: 'keys:KeyW', action: 'jump' }] },
        );
        untilLive(h);
        h.device.emit({ kind: 'key', code: 'keys:KeyW', down: true });
        h.run(2);

        h.runSilent(70);
        expect(h.client.state).toBe('stalled');
        const before = h.server.inputs.length;
        h.run(10);
        expect(h.client.state).toBe('live');

        const presses = h.server.inputs
            .slice(before)
            .flatMap((i) => i.frame.actions)
            .filter((a) => a.action === 'jump' && a.on === 'press');
        expect(presses).toHaveLength(0);
    });

    it('re-sends a still-deflected axis when input resumes, which nothing else would mention', async () => {
        const h = await harness(
            {},
            { bindings: [{ kind: 'axis', code: 'pad:x', action: 'moveX' }] },
        );
        untilLive(h);
        h.device.emit({ kind: 'axis', code: 'pad:x', value: 0.5 });
        h.run(2);

        h.runSilent(70);
        expect(h.client.state).toBe('stalled');
        const before = h.server.inputs.length;
        h.run(10);

        const holds = h.server.inputs
            .slice(before)
            .flatMap((i) => i.frame.actions)
            .filter((a) => a.action === 'moveX');
        expect(holds).toHaveLength(1);
        expect(holds[0]?.value).toBe(0.5);
    });
});

describe('an untrusted frame ends up as state, never as a throw', () => {
    it('drops a state envelope missing the arrays the client walks, and stays live', async () => {
        const h = await harness();
        untilLive(h);
        h.server.sendRaw({ kind: 'state', tick: h.server.tick, ackSeq: 0 });
        h.run(2);
        expect(h.client.state).toBe('live');
    });

    it('drops a state envelope whose arrays exceed the cardinality cap, and stays live', async () => {
        const h = await harness();
        untilLive(h);
        // Well-formed items, just too many of them: the count is peer-chosen and the walk is linear
        // in it, so it is refused before the walk rather than during.
        h.server.sendRaw({
            kind: 'state',
            tick: h.server.tick,
            ackSeq: 0,
            structural: [],
            state: Array.from({ length: MAX_WIRE_ITEMS + 1 }, () => ({
                host: { kind: 'game' },
                fields: {},
            })),
        });
        h.run(2);
        expect(h.client.state).toBe('live');
    });

    it('drops a rate-change with a nonsense simRate rather than rebuilding the clock on it', async () => {
        const h = await harness();
        untilLive(h);
        h.server.sendRaw({ kind: 'rate-change', tick: h.server.tick, simRate: 0 });
        h.run(2);
        expect(h.client.state).toBe('live');
        expect(h.server.joins).toHaveLength(1);
    });

    it('fails as `peer` when an op is malformed deeper than the boundary checks reach', async () => {
        // The backstop: a spawn with no transform throws inside the mirror, and without a catch it
        // unwinds through `frame()` into the frame source — ending the session with no state to show.
        const h = await harness();
        untilLive(h);
        h.server.sendRaw({
            kind: 'state',
            tick: h.server.tick,
            ackSeq: 0,
            structural: [{ kind: 'spawn', snapshot: { netId: 9, template: 'x' } }],
            state: [],
        });
        expect(() => h.run(2)).not.toThrow();
        expect(h.client.state).toBe('failed');
        expect(h.client.lifecycle.failure?.kind).toBe('peer');
    });

    it('treats a Welcome missing bounds as undecodable, not as a crash', async () => {
        // `wireBounds` reads four fields off it unguarded, and `regions.map` needs an array.
        const h = await harness({}, { start: false });
        h.server.sendRaw({
            kind: 'welcome',
            protocolVersion: 1,
            yourPlayerId: 'p1',
            simRate: 60,
            sendRate: 20,
            regions: [],
            visuals: { assets: [], templates: [] },
            snapshot: { tick: 0, entities: [], players: [], state: [] },
        });
        h.client.start();
        expect(() => h.run(3)).not.toThrow();
        expect(h.client.state).toBe('failed');
        expect(h.client.lifecycle.failure?.kind).toBe('undecodable');
    });

    it('counts a manifest that fails to load and keeps the session', async () => {
        // Missing art draws as a placeholder; an unhandled rejection takes down the host page.
        const h = await harness(
            {
                visuals: {
                    assets: [{ key: assetId('art'), kind: 'texture', url: '/a.png' }],
                    templates: [],
                },
            },
            { start: false },
        );
        h.renderer.loadAssets = (): Promise<never> => Promise.reject(new Error('offline'));
        h.client.start();
        untilLive(h);
        await settle();
        h.run(1);
        expect(h.client.state).toBe('live');
        expect(h.client.stats().assetLoadFailed).toBe(1);
    });
});

describe('teardown', () => {
    it('is idempotent under a double call and leaves no live handler, node, or runtime', async () => {
        const h = await harness({ entities: [entity(1)] });
        untilLive(h);
        expect(h.client.stats().nodeCount).toBe(1);

        h.client.destroy();
        h.client.destroy();

        expect(h.device.disposed).toBe(true);
        expect(h.client.mirror).toBeUndefined();
        // The frame source is stopped, so a further frame does nothing at all.
        expect(() => h.run(3)).not.toThrow();
    });

    it('leaves the renderer alone unless it owns it', async () => {
        const h = await harness();
        untilLive(h);
        h.client.destroy();
        expect(h.renderer.initialized).toBe(true);

        const owned = await harness();
        untilLive(owned);
        owned.client.destroy({ ownsRenderer: true });
        expect(owned.renderer.initialized).toBe(false);
    });
});
