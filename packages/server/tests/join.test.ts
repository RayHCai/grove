// Connection and join (DESIGN §3, §7, §8). Fixtures are compiled by the build (see
// src/testkit/fixtures.ts); this file carries no decorator syntax.

import { afterEach, describe, expect, it } from 'vitest';
import { clearRuntime } from '@platform/core';
import { PROTOCOL_VERSION } from '@platform/protocol';
import { Health, Rules, Spectators, Wallet } from '../dist/testkit/fixtures.js';
import { JOIN_DEADLINE_MS, MAX_UNJOINED_CONNECTIONS } from '../src/constants.js';
import { harness } from './harness.js';

afterEach(() => {
    // One runtime is module-global in core, so a leaked one would answer the next test's facades.
    clearRuntime();
});

describe('§3.2 — the client speaks first', () => {
    it('accept() mints a connection, sends nothing, and mutates no roster', () => {
        const h = harness();
        const peer = h.connect();
        h.pumpTicks(3);

        expect(peer.received).toStrictEqual([]);
        expect(h.server.runtime.playerManager?.players).toHaveLength(0);
        expect(h.server.connections).toHaveLength(1);
        expect(h.server.connections[0]?.player).toBeNull();
    });

    it('the first valid JoinRequest allocates the Player and answers with Welcome first', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.connect();
        peer.join('Ray');
        h.pumpTicks(6);

        const welcome = peer.welcome;
        expect(peer.received[0]?.kind).toBe('welcome');
        expect(welcome?.yourPlayerId).toBe('c1');
        expect(welcome?.yourPlayerIndex).toBe(0);
        expect(h.server.runtime.playerManager?.players).toHaveLength(1);
    });

    it('index is roster-assigned and keeps climbing, so a client must adopt rather than renumber', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const first = h.joined('a');
        const second = h.joined('b');
        expect(first.welcome?.yourPlayerIndex).toBe(0);
        expect(second.welcome?.yourPlayerIndex).toBe(1);

        first.close();
        h.pumpTicks(2);
        const third = h.joined('c');
        // NOT 1: PlayerManager.remove does not decrement its counter, which is exactly why the
        // index must be wire-carried rather than derived from arrival order.
        expect(third.welcome?.yourPlayerIndex).toBe(2);
    });

    it('Welcome carries the rates, the extent, and no tick / maxPlayers / undefined token', () => {
        const h = harness({
            config: {
                simRate: 60,
                sendRate: 20,
                bounds: { left: -10, right: 10, top: 5, bottom: -5 },
                regions: [{ name: 'arena', bounds: { left: 0, right: 4, top: 4, bottom: 0 } }],
                gameScripts: [Rules],
            },
        });
        const welcome = h.joined().welcome;

        expect(welcome?.simRate).toBe(60);
        expect(welcome?.sendRate).toBe(20);
        expect(welcome?.bounds).toStrictEqual({ left: -10, right: 10, top: 5, bottom: -5 });
        expect(welcome?.regions[0]?.name).toBe('arena');
        // The tick rides snapshot.tick, so the tick a joiner seeds from cannot disagree with the
        // tick the world it describes was read at (protocol §3.2).
        expect(welcome && 'tick' in welcome).toBe(false);
        expect(welcome && 'maxPlayers' in welcome).toBe(false);
        // Omitted, not explicitly undefined: jsonCodec throws on the latter (protocol §4).
        expect(welcome && 'reconnectToken' in welcome).toBe(false);
    });

    it('echoes clientSentMs byte-identically — only the client differences its own stamps', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.connect();
        peer.join('Ray', { clientSentMs: 987_654 });
        h.pumpTicks(6);
        expect(peer.welcome?.clientSentMs).toBe(987_654);
    });

    it('sanitizes the untrusted name, and the roster carries the sanitized form', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.connect();
        peer.join(`ev\u0000il\u001b[31m${'x'.repeat(50)}`);
        h.pumpTicks(6);

        const name = h.server.runtime.playerManager?.players[0]?.name ?? '';
        expect([...name].every((c) => (c.codePointAt(0) ?? 0) >= 0x20)).toBe(true);
        expect(name.length).toBeLessThanOrEqual(24);
        expect(peer.welcome?.snapshot.players[0]?.name).toBe(name);
    });

    it('a blank name becomes a placeholder rather than an empty roster entry', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.connect();
        peer.join('   ');
        h.pumpTicks(6);
        expect(h.server.runtime.playerManager?.players[0]?.name).toBe('player');
    });
});

describe('§3.2 — refusals are envelopes, never a bare close', () => {
    it('maxPlayers refuses with Reject { full } and leaves the roster untouched', () => {
        const h = harness({ config: { maxPlayers: 2, gameScripts: [Rules] } });
        h.joined('a');
        h.joined('b');

        const third = h.connect();
        third.join('c');
        h.pumpTicks(6);

        expect(third.reject?.reason).toBe('full');
        expect(third.reject?.serverProtocolVersion).toBe(PROTOCOL_VERSION);
        expect(third.welcome).toBeUndefined();
        expect(h.server.runtime.playerManager?.players).toHaveLength(2);
    });

    it('a version mismatch refuses before anything is built', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.connect();
        peer.join('old', { protocolVersion: PROTOCOL_VERSION + 1 });
        h.pumpTicks(6);

        expect(peer.received).toHaveLength(1);
        expect(peer.reject?.reason).toBe('version');
        expect(h.server.runtime.playerManager?.players).toHaveLength(0);
    });

    it('a malformed frame is ignored and the connection survives', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.connect();
        peer.raw({ kind: 'join-request' }); // no version, no name, no stamp
        peer.raw({ kind: 'state', tick: 1 }); // a server-direction kind
        peer.raw(42);
        h.pumpTicks(2);
        expect(peer.received).toStrictEqual([]);

        peer.join('recovered');
        h.pumpTicks(6);
        expect(peer.welcome?.yourPlayerId).toBe('c1');
    });

    it('a join request carrying no identity fields never reaches the join at all', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.connect();
        // What an older client sends. The narrowing checks every field it claims to check, so this
        // is malformed rather than an admitted frame with three fields defaulted to nothing.
        peer.raw({
            kind: 'join-request',
            protocolVersion: PROTOCOL_VERSION,
            name: 'old',
            clientSentMs: 1,
        });
        h.pumpTicks(4);

        expect(peer.received).toStrictEqual([]);
        expect(h.server.runtime.playerManager?.players).toHaveLength(0);
    });
});

describe('§3.2 — the handshake proves both ends run the same bytes', () => {
    const project = {
        projectId: 'arcade',
        projectHash: 'build-7',
        bundleHash: 'abc123',
        bundleUrl: '/bundle.js',
    };

    it('welcomes a client running the same project, and names the bundle to fetch', () => {
        const h = harness({ config: { project, gameScripts: [Rules] } });
        const peer = h.connect();
        peer.join('a', { projectId: 'arcade', projectHash: 'build-7' });
        h.pumpTicks(6);

        const welcome = peer.welcome;
        expect(welcome?.projectId).toBe('arcade');
        expect(welcome?.projectHash).toBe('build-7');
        expect(welcome?.bundleHash).toBe('abc123');
        expect(welcome?.bundleUrl).toBe('/bundle.js');
    });

    it('refuses another build with `identity`, before a Player is allocated', () => {
        const h = harness({ config: { project, gameScripts: [Rules] } });
        const peer = h.connect();
        peer.join('stale', { projectId: 'arcade', projectHash: 'build-6' });
        h.pumpTicks(6);

        expect(peer.received).toHaveLength(1);
        expect(peer.reject?.reason).toBe('identity');
        expect(h.server.runtime.playerManager?.players).toHaveLength(0);
    });

    it('refuses another project the same way — the reason stays coarse', () => {
        const h = harness({ config: { project, gameScripts: [Rules] } });
        const peer = h.connect();
        peer.join('elsewhere', { projectId: 'other', projectHash: 'build-7' });
        h.pumpTicks(6);
        expect(peer.reject?.reason).toBe('identity');
    });

    it('refuses identity ahead of capacity: a wrong build is not told to come back later', () => {
        const h = harness({ config: { project, maxPlayers: 1, gameScripts: [Rules] } });
        const first = h.connect();
        first.join('a', { projectId: 'arcade', projectHash: 'build-7' });
        h.pumpTicks(6);
        expect(first.welcome).toBeDefined();

        const second = h.connect();
        second.join('b', { projectId: 'arcade', projectHash: 'nope' });
        h.pumpTicks(6);
        expect(second.reject?.reason).toBe('identity');
    });

    it('admits an empty bundleHash — a joiner holds none — and refuses a stale one', () => {
        const h = harness({ config: { project, gameScripts: [Rules] } });
        const fresh = h.connect();
        fresh.join('fresh', { projectId: 'arcade', projectHash: 'build-7', bundleHash: '' });
        h.pumpTicks(6);
        expect(fresh.welcome).toBeDefined();

        const stale = h.connect();
        stale.join('stale', {
            projectId: 'arcade',
            projectHash: 'build-7',
            bundleHash: 'held-from-a-previous-build',
        });
        h.pumpTicks(6);
        expect(stale.reject?.reason).toBe('identity');
    });

    it('an unconfigured server admits a client that declares nothing, and only that', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const blank = h.joined('blank');
        expect(blank.welcome?.projectId).toBe('');

        const declaring = h.connect();
        declaring.join('declaring', { projectId: 'arcade', projectHash: 'build-7' });
        h.pumpTicks(6);
        // A one-sided declaration is a disagreement, not a pass: the two are not running the same
        // thing and neither end can tell which of them is wrong.
        expect(declaring.reject?.reason).toBe('identity');
    });

    it('re-checks on a resync, since a client may have loaded a bundle since it joined', () => {
        const h = harness({ config: { project, gameScripts: [Rules] } });
        const peer = h.connect();
        peer.join('a', { projectId: 'arcade', projectHash: 'build-7' });
        h.pumpTicks(6);
        expect(peer.welcome).toBeDefined();
        peer.clear();

        peer.join('a', { projectId: 'arcade', projectHash: 'build-7', bundleHash: 'wrong' });
        h.pumpTicks(6);
        expect(peer.reject?.reason).toBe('identity');
    });
});

describe('§3.3 — the join snapshot is a walk of the live world', () => {
    it('is complete, current, and per-player scoped for state', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const first = h.joined('a');
        const rt = h.server.runtime;

        // Player-hosted @serverState on the first player only.
        rt.playerManager?.players[0]?.addScript(Wallet as never);
        const crate = rt.entityManager.spawn('crate', 7, 9);
        crate.addScript(Health as never);
        h.pumpTicks(4);

        const second = h.joined('b');
        const snapshot = second.welcome?.snapshot;

        // The tick the walk was read at, which the joiner's counter seeds from — behind `rt.tick`
        // by however many ticks have been stepped since the Welcome was built.
        expect(snapshot?.tick).toBeGreaterThan(0);
        expect(snapshot?.tick).toBeLessThanOrEqual(rt.tick);
        const templates = snapshot?.entities.map((e) => e.template) ?? [];
        expect(templates).toContain('crate');
        const wire = snapshot?.entities.find((e) => e.template === 'crate');
        expect(wire?.transform.posX).toBe(7);
        expect(wire?.transform.posY).toBe(9);
        expect(wire?.transform.scale).toBe(1);

        // Game and entity state reach a joiner; another player's player-scoped state does not.
        const fields = snapshot?.state ?? [];
        expect(fields.some((f) => f.host.kind === 'game' && 'round' in f.fields)).toBe(true);
        expect(fields.some((f) => f.host.kind === 'entity' && 'health' in f.fields)).toBe(true);
        expect(fields.some((f) => 'credits' in f.fields)).toBe(false);
        expect(first.welcome).toBeDefined();
    });

    it('carries the roster, and an avatar names its owner', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        h.joined('a');
        const second = h.joined('b');
        const snapshot = second.welcome?.snapshot;

        expect(snapshot?.players.map((p) => p.id)).toStrictEqual(['c1', 'c2']);
        const owned = snapshot?.entities.filter((e) => e.owner !== null) ?? [];
        expect(owned.map((e) => e.owner)).toContain('c1');
    });

    it('is current at the join tick, not as of any earlier send', () => {
        const h = harness({ config: { gameScripts: [Rules], sendRate: 20 } });
        h.joined('a');
        const crate = h.server.runtime.entityManager.spawn('crate', 0, 0);
        h.pumpTicks(3); // a send-tick boundary at 60/20
        crate.setPosition(123, 456);
        h.pumpTicks(1); // mid-interval: no send has carried this position

        const snapshot = h.joined('b').welcome?.snapshot;
        const wire = snapshot?.entities.find((e) => e.template === 'crate');
        expect(wire?.transform.posX).toBe(123);
        expect(wire?.transform.posY).toBe(456);
    });

    it('omits a destroyed entity, because liveIds() is the source', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        h.joined('a');
        const doomed = h.server.runtime.entityManager.spawn('ghost', 1, 1);
        doomed.destroy();
        h.pumpTicks(2); // the destroy drain runs inside the step

        const snapshot = h.joined('b').welcome?.snapshot;
        expect(snapshot?.entities.some((e) => e.template === 'ghost')).toBe(false);
    });

    it('emits parents before children even when the child holds the lower slot', () => {
        const h = harness({ config: { gameScripts: [Spectators] } });
        h.joined('a');
        const rt = h.server.runtime;
        // The order protocol §3.6.1 names: parenting is a post-hoc mutation, so slot order puts
        // the child first and a slot sweep would ship it first.
        const child = rt.entityManager.spawn('child', 0, 0);
        const parent = rt.entityManager.spawn('parent', 0, 0);
        child.attachTo(parent);
        h.pumpTicks(2);

        const entities = h.joined('b').welcome?.snapshot.entities ?? [];
        const at = (template: string) => entities.findIndex((e) => e.template === template);
        expect(at('parent')).toBeGreaterThanOrEqual(0);
        expect(at('parent')).toBeLessThan(at('child'));
        expect(entities[at('child')]?.parent).toBe(parent.entityId as unknown as number);
    });
});

describe('§4.3 — the unjoined connection is bounded', () => {
    it('closes a connection that never sends a JoinRequest', () => {
        const h = harness();
        const peer = h.connect();
        h.pumpTicks(2);
        expect(h.server.connections).toHaveLength(1);

        h.pump(JOIN_DEADLINE_MS / 1000);
        h.pumpTicks(2);
        expect(h.server.connections).toHaveLength(0);
        expect(peer.received).toStrictEqual([]);
    });

    it('unjoined sockets consume no roster slot, so maxPlayers real joins still fit behind them', () => {
        const h = harness({ config: { maxPlayers: 2, gameScripts: [Rules] } });
        for (let i = 0; i < MAX_UNJOINED_CONNECTIONS - 1; i++) h.connect();
        h.pumpTicks(1);

        // A shared cap would let unjoined sockets lock out real players — the same denial wearing
        // the admission check as a costume. Distinct caps mean the roster is untouched by them.
        const first = h.joined('a');
        const second = h.joined('b');
        expect(first.welcome).toBeDefined();
        expect(second.welcome).toBeDefined();
        expect(h.server.runtime.playerManager?.players).toHaveLength(2);
    });

    it('refuses a new socket once the unjoined cap is full', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        for (let i = 0; i < MAX_UNJOINED_CONNECTIONS; i++) h.connect();
        h.pumpTicks(1);

        const overflow = h.connect();
        overflow.join('late');
        h.pumpTicks(6);
        expect(overflow.welcome).toBeUndefined();
    });
});

describe('§7 — disconnection', () => {
    it('close removes the connection and the player, and the next broadcast skips it', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const first = h.joined('a');
        const second = h.joined('b');
        expect(h.server.runtime.playerManager?.players).toHaveLength(2);

        first.close();
        h.pumpTicks(4);

        expect(h.server.connections.map((c) => c.connectionId)).toStrictEqual(['c2']);
        expect(h.server.runtime.playerManager?.players.map((p) => p.id)).toStrictEqual(['c2']);
        second.clear();
        h.pumpTicks(4);
        expect(second.states.length).toBeGreaterThan(0);
    });

    it('fires @onPlayerLeave on the Game-hosted ServerScript', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        const rules = [...h.server.runtime.instances.forHost('game')][0]?.instance as Rules;
        expect(rules.joined).toStrictEqual(['c1']);

        peer.close();
        h.pumpTicks(2);
        // Dispatched BEFORE the roster removal, so the handler still reads the player it is told
        // about — the core gap §9 item 0 named as a prerequisite of this server.
        expect(rules.left).toStrictEqual(['c1']);
    });

    it('destroys the leaving player’s owned entities before the leave', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        const rt = h.server.runtime;
        const owned = rt.entities
            .liveIds()
            .filter((id) => rt.entities.record(id)?.ownerId === 'c1');
        expect(owned).toHaveLength(1);

        peer.close();
        h.pumpTicks(3);
        expect(
            rt.entities.liveIds().filter((id) => rt.entities.record(id)?.ownerId === 'c1'),
        ).toHaveLength(0);
    });

    it('runs the transport disposers exactly once', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        const conn = h.server.connections[0];
        expect(conn?.disposers.length).toBe(2);

        peer.close();
        h.pumpTicks(2);
        expect(conn?.disposers).toHaveLength(0);
    });
});

describe('§6.3 — the clock-sync and rate frames', () => {
    it('answers TimeSync by echoing the client stamp untouched', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        peer.timeSync(4242);
        h.pumpTicks(6);

        const reply = peer.timeSyncReplies[0];
        expect(reply?.clientSentMs).toBe(4242);
        expect(reply?.serverTick).toBeGreaterThan(0);
        // A server stamp differenced against a client one is RTT plus an unknown offset, so it is
        // carried for diagnostics and never compared.
        expect(typeof reply?.serverSentMs).toBe('number');
    });

    it('emits one RateChange per joined connection on setSimRate', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        peer.clear();
        h.server.setSimRate(30);
        h.pumpTicks(2);

        const changes = peer.received.filter((e) => e.kind === 'rate-change');
        expect(changes).toHaveLength(1);
        expect(changes[0]).toMatchObject({ simRate: 30 });
    });
});
