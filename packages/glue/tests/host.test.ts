// What the host owes the sim: the sockets it writes to, the store its loads and saves go through,
// and the isolation that keeps one broken peer from taking the broadcast down.
//
// The sim decides all of it and can prove none of it — an output batch names a send, a close, a load
// and a save, and whether any of them happens is this half's alone.

import { afterEach, describe, expect, it } from 'vitest';
import type { KVStore } from '@platform/core';
import { MemoryKVStore, PERSISTENCE_SCOPE, clearRuntime, playerKey } from '@platform/core';
import { PROTOCOL_VERSION } from '@platform/protocol';
import type { JoinRequest, ServerToClient } from '@platform/protocol';
import { PROJECT_FORMAT_VERSION, assetId, scriptId, templateId } from '@platform/project';
import type { ProjectManifest } from '@platform/project';
import { ScriptRegistry } from '@platform/scripting';
import type { ScriptEntry } from '@platform/scripting';
import type { Message, Transport } from '@platform/transport';
import { loopbackPair } from '@platform/transport';
import { Bank, Wallet } from '../dist/testkit/fixtures.js';
import { GameInstance } from '../src/server/index.js';

const BANK = scriptId('bank');
const PIP = templateId('pip');
const DOT = assetId('dot');

afterEach(() => clearRuntime());

function registry(): ScriptRegistry<typeof BANK> {
    const entries: ScriptEntry<typeof BANK>[] = [{ id: BANK, location: 'server', ctor: Bank }];
    return ScriptRegistry.from(entries);
}

function project(): ProjectManifest {
    return {
        formatVersion: PROJECT_FORMAT_VERSION,
        projectId: 'host-test',
        contentHash: '1',
        settings: {
            simRate: 60,
            sendRate: 20,
            maxPlayers: 4,
            bounds: { left: -100, right: 100, top: 100, bottom: -100 },
            regions: [],
        },
        assets: [{ id: DOT, kind: 'texture', url: '/dot.png' }],
        scriptModules: [
            {
                path: 'bank.ts',
                scripts: [{ id: BANK, export: 'Bank', location: 'server', host: 'game' }],
            },
        ],
        templates: [{ id: PIP, visual: { kind: 'sprite', texture: DOT }, scripts: [] }],
        entities: [],
        gameScripts: [{ script: BANK }],
    };
}

const JOIN: JoinRequest = {
    kind: 'join-request',
    protocolVersion: PROTOCOL_VERSION,
    name: 'peer',
    clientSentMs: 1000,
    projectId: 'host-test',
    projectHash: '1',
    bundleHash: '',
};

/** One peer over a loopback pair, driven by the same hand-turned clock the instance is. */
class Peer {
    readonly received: ServerToClient[] = [];
    readonly deliver: () => void;
    readonly #client: Transport;

    constructor(instance: GameInstance, playerId?: string) {
        const pair = loopbackPair({ latency: 1 });
        this.deliver = pair.deliver;
        this.#client = pair.client;
        this.#client.onMessage((m) => this.received.push(m as unknown as ServerToClient));
        instance.accept(pair.server, playerId);
    }

    join(): void {
        this.#client.send(JOIN as unknown as Message);
    }

    close(): void {
        this.#client.close();
    }

    get welcome(): ServerToClient | undefined {
        return this.received.find((e) => e.kind === 'welcome');
    }
}

/** A transport a test can make throw, so the isolation is measured rather than assumed. */
class FlakyTransport implements Transport {
    readonly sent: ServerToClient[] = [];
    failEncoded = false;
    failSend = false;
    closed = false;
    #onMessage: ((message: Message) => void) | null = null;

    send(message: Message): void {
        if (this.failSend) throw new Error('socket write failed');
        this.sent.push(message as unknown as ServerToClient);
    }

    sendEncoded(): void {
        if (this.failEncoded) throw new Error('socket write failed');
    }

    onMessage(handler: (message: Message) => void): () => void {
        this.#onMessage = handler;
        return () => {
            this.#onMessage = null;
        };
    }

    onClose(): () => void {
        return () => {};
    }

    close(): void {
        this.closed = true;
    }

    /** Hands the host one frame, the way a socket's own event loop would. */
    receive(message: unknown): void {
        this.#onMessage?.(message as Message);
    }
}

/** An instance on a hand-turned clock, with `deliver` wired the way a loopback host wires it. */
function hosted(opts: { kv?: KVStore; onLog?: (line: string) => void } = {}): {
    instance: GameInstance;
    peers: Peer[];
    step(ticks: number): Promise<void>;
    lines: string[];
} {
    const peers: Peer[] = [];
    const lines: string[] = [];
    let now = 0;
    const instance = new GameInstance({
        project: project(),
        scripts: registry(),
        ...(opts.kv === undefined ? {} : { kv: opts.kv }),
        deliver: () => {
            for (const peer of peers) peer.deliver();
        },
        onLog: (line) => {
            lines.push(line);
            opts.onLog?.(line);
        },
    });
    return {
        instance,
        peers,
        lines,
        async step(ticks: number): Promise<void> {
            for (let i = 0; i < ticks; i++) {
                now += 1 / 60;
                instance.pump(now);
                // An identified join waits on a store read the host answers on the microtask queue,
                // so a synchronous loop would never let the join finish.
                for (let k = 0; k < 6; k++) await Promise.resolve();
            }
        },
    };
}

describe('the host writes what the batch told it to', () => {
    it('carries a join through the socket, the sim and back', async () => {
        const h = hosted();
        const peer = new Peer(h.instance, 'alice');
        h.peers.push(peer);
        peer.join();
        await h.step(16);

        expect(peer.welcome).toBeDefined();
        void h.instance.close();
    });

    it('encodes a shared envelope once, however many peers take it', async () => {
        const h = hosted();
        for (const id of ['a', 'b', 'c']) {
            const peer = new Peer(h.instance, id);
            h.peers.push(peer);
            peer.join();
        }
        await h.step(24);

        // The sim addresses the transform envelope to every peer at once, and this is the half that
        // turns that into one `encode` and N `sendEncoded` calls.
        for (const peer of h.peers) {
            expect(peer.received.some((e) => e.kind === 'transform')).toBe(true);
        }
        void h.instance.close();
    });
});

describe('one peer’s failure is that peer’s alone', () => {
    it('closes the connection whose send threw and finishes the broadcast', async () => {
        const h = hosted();
        // Taken first, so it is ahead of the healthy peer in the registry — behind it, an unisolated
        // throw would prove nothing.
        const flaky = new FlakyTransport();
        h.instance.accept(flaky, 'flaky');
        flaky.receive(JOIN);
        await h.step(12);
        expect(flaky.sent.some((e) => e.kind === 'welcome')).toBe(true);

        const good = new Peer(h.instance, 'good');
        h.peers.push(good);
        good.join();
        await h.step(12);
        good.received.length = 0;

        flaky.failSend = true;
        flaky.failEncoded = true;
        await h.step(12);

        expect(flaky.closed).toBe(true);
        expect(h.lines.some((l) => l.includes('reason=send-failed'))).toBe(true);
        expect(good.received.length).toBeGreaterThan(0);
        void h.instance.close();
    });
});

describe('close() drains the saves it starts', () => {
    it('settles only once an online player’s state has reached the store', async () => {
        const backing = new MemoryKVStore();
        const h = hosted({ kv: deferred(backing) });
        const peer = new Peer(h.instance, 'alice');
        h.peers.push(peer);
        peer.join();
        await h.step(24);
        walletOf(h.instance, 'alice').credits = 42;
        await h.step(4);

        await h.instance.close();

        // Every deploy and every container eviction runs this path, so a save still in flight at
        // exit is silent, total loss for every player who was online.
        expect(await backing.get(PERSISTENCE_SCOPE, playerKey('alice'))).toMatchObject({
            credits: 42,
        });
    });

    it('releases the drain when the store rejects, rather than hanging the shutdown', async () => {
        const kv: KVStore = {
            get: () => Promise.resolve(undefined),
            set: () => Promise.reject(new Error('store unreachable')),
            delete: () => Promise.resolve(),
        };
        const h = hosted({ kv });
        const peer = new Peer(h.instance, 'alice');
        h.peers.push(peer);
        peer.join();
        await h.step(24);

        await expect(h.instance.close()).resolves.toBeUndefined();
    });

    it('is idempotent, and a second caller waits on the first call’s drain', async () => {
        const backing = new MemoryKVStore();
        const h = hosted({ kv: deferred(backing) });
        const peer = new Peer(h.instance, 'alice');
        h.peers.push(peer);
        peer.join();
        await h.step(24);
        walletOf(h.instance, 'alice').credits = 7;
        await h.step(4);

        const first = h.instance.close();
        await h.instance.close();
        await first;
        expect(await backing.get(PERSISTENCE_SCOPE, playerKey('alice'))).toMatchObject({
            credits: 7,
        });
    });
});

/** A store whose writes land a turn late, which is what every real one does. */
function deferred(backing: KVStore): KVStore {
    return {
        get: (scope, key) => backing.get(scope, key),
        set: (scope, key, value) =>
            new Promise((resolve) => {
                setTimeout(() => void backing.set(scope, key, value).then(resolve), 0);
            }),
        delete: (scope, key) => backing.delete(scope, key),
    };
}

function walletOf(instance: GameInstance, id: string): Wallet {
    return [...instance.sim.runtime.instances.forHost(playerKey(id))]
        .map((si) => si.instance)
        .find((i): i is Wallet => i instanceof Wallet)!;
}
