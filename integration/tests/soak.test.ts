// Every package, composed the way an application composes them, driven by a pseudo-random sequence
// of the things a person does: open a tab, hold a key, click something, press a button, close the
// tab.
//
// The sequence is seeded, so the run is a REPLAY rather than a lottery — a failure here reproduces
// on the next run of the same seed, and the same-seed digest comparison below is what pins that.
// What the driver chooses is arbitrary; what it asserts is not.

import { beforeAll, describe, expect, it } from 'vitest';
import type { EntityId, Runtime } from '@platform/core';
import { GAME_KEY, MemoryKVStore, playerKey } from '@platform/core';
import { SeededRandom } from '@platform/math';
import type { GameServer } from '@platform/server';
import {
    CODE_DOWN,
    CODE_LEFT,
    CODE_RIGHT,
    CODE_UP,
    MAX_PLAYERS,
    SCREEN_PANEL,
    STATE_COLLECTED,
    STATE_LIFETIME,
    STATE_ORBS,
    STATE_PHASE,
    STATE_PLAYERS,
    STATE_POPPED,
    STATE_COOLED,
    STATE_RIPENED,
    STATE_SWEEPS,
    STATE_TAKEN,
    STATE_WALKED,
    TAG_ORB,
    TEMPLATE_SHADOW,
    WIDGET_SWEEP,
    WORLD,
} from '../dist/globals.js';
import { PROJECT } from '../dist/project.js';
import type { Session, Tab } from './harness.js';
import {
    avatarIn,
    gameField,
    newSession as openSession,
    playerField,
    runtimeOf,
    taggedIn,
    templatesIn,
} from './harness.js';
import { SOAK } from '../dist/worlds/soak.js';

/** This suite drives one world, so no call below has to name it. */
const newSession = (store?: MemoryKVStore): Session => openSession(SOAK, store);

const orbsIn = (rt: Runtime): EntityId[] => taggedIn(rt, TAG_ORB);

/** The seed the committed run uses. Any other seed is a different, equally valid session. */
const SEED = 20_260_831;
/** Actions in the long run, and in the two short ones the replay check compares. */
const BEATS = 600;
const SHORT_BEATS = 120;

const CODES = [CODE_LEFT, CODE_RIGHT, CODE_UP, CODE_DOWN];
/** More identities than seats, so a rejoin under a used one is something the driver can pick. */
const IDENTITIES = ['ada', 'brin', 'cyd', 'dara', 'eli', 'fen'];

type Action = 'join' | 'leave' | 'hold' | 'release' | 'click' | 'sweep' | 'idle';

/**
 * What each action is worth in the draw, before the ones nothing can do are struck out.
 *
 * A sweep clears the stage, so it is rare on purpose: at anything like the weight of the others it
 * keeps the world empty and the click and collision paths never get anything to act on.
 */
const WEIGHTS: Array<[Action, number]> = [
    ['hold', 20],
    ['release', 12],
    ['click', 5],
    ['sweep', 1],
    ['join', 4],
    ['leave', 2],
    ['idle', 6],
];

/** One tab's answer against the authority's, taken once the input has stopped. */
interface Settled {
    name: string;
    state: string;
    /** Null when this tab never reached a body — a join still in flight when the input stopped. */
    avatar: { mirror: [number, number]; server: [number, number] } | null;
    orbs: { mirror: number; server: number };
    game: { mirror: Record<string, unknown>; server: Record<string, unknown> };
    taken: { mirror: number; server: number };
    /** Another player's own score, if this tab was told it. Player-scoped state must never be. */
    leaked: string[];
    cappedReplays: number;
    resimulations: number;
    /** Corrections too large to ease. This world never disagrees, so any of these is a fault. */
    snappedCorrections: number;
}

interface Report {
    tally: Record<Action, number>;
    /** Clicks the render layer resolved to an entity, out of the clicks attempted. */
    clicks: number;
    hits: number;
    peakTabs: number;
    /** Distinct orbs the authority ever held, and what every tab together took off it. */
    orbsSpawned: number;
    collected: number;
    /** The take split by route, so a run cannot claim both paths on the strength of one. */
    walked: number;
    popped: number;
    ripened: number;
    cooled: number;
    sweeps: number;
    /** One line per health check that failed, naming the beat it failed on. Empty is the pass. */
    faults: string[];
    settled: Settled[];
    /** The whole server world at the end of the driven run, as one comparable string. */
    digest: string;
    /** The world after every tab has closed. */
    emptied: { players: number; orbs: number; entities: string[]; phase: string };
}

/**
 * Drives one seeded session and reports what happened.
 *
 * Health is COLLECTED rather than thrown: a soak that stopped at the first fault would hide every
 * later one, and the beat number in the line is what makes a failure reproducible from the seed.
 */
async function soak(seed: number, beats: number): Promise<Report> {
    const rng = new SeededRandom(seed);
    const session = newSession();
    const tally: Record<Action, number> = {
        join: 0,
        leave: 0,
        hold: 0,
        release: 0,
        click: 0,
        sweep: 0,
        idle: 0,
    };
    const faults: string[] = [];
    const watch: Watch = { counters: new Map(), logs: new WeakMap() };
    const orbsEverSeen = new Set<EntityId>();
    let clicks = 0;
    let hits = 0;
    let peakTabs = 0;
    let named = 0;

    for (let beat = 0; beat < beats; beat++) {
        const action = draw(rng, session);
        tally[action] += 1;

        switch (action) {
            case 'join': {
                const free = IDENTITIES.filter(
                    (id) => !session.tabs.some((tab) => tab.identity === id),
                );
                if (free.length > 0) await session.join(`tab${named++}`, rng.pick(free));
                break;
            }
            case 'leave':
                session.leave(rng.pick(session.tabs));
                break;
            case 'hold': {
                const tab = rng.pick(session.tabs);
                session.hold(tab, rng.pick(CODES));
                break;
            }
            case 'release': {
                const holding = session.tabs.filter((tab) => tab.held.size > 0);
                if (holding.length > 0) {
                    const tab = rng.pick(holding);
                    session.release(tab, rng.pick([...tab.held]));
                }
                break;
            }
            case 'click': {
                const tab = rng.pick(session.tabs);
                const target = pickOrb(tab, rng);
                if (target !== undefined) {
                    clicks += 1;
                    if (session.click(tab, target) !== undefined) hits += 1;
                }
                break;
            }
            case 'sweep':
                session.press(rng.pick(session.tabs), WIDGET_SWEEP, SCREEN_PANEL);
                break;
            case 'idle':
                break;
        }

        await session.step(1 + Math.floor(rng.between(0, 6)));

        peakTabs = Math.max(peakTabs, session.tabs.length);
        for (const id of orbsIn(session.server.runtime)) orbsEverSeen.add(id);
        faults.push(...health(session, beat, watch));
    }

    // However the draw left the roster, the run ends with a full house: the agreement check below
    // is about tabs disagreeing with EACH OTHER as much as with the authority, and a run that
    // happened to end on one tab could not see that.
    while (session.tabs.length < MAX_PLAYERS) {
        const free = IDENTITIES.find((id) => !session.tabs.some((tab) => tab.identity === id));
        if (free === undefined) break;
        await session.join(`late${named++}`, free);
    }
    await session.live(...session.tabs);

    // Nothing held, and long enough for the last input frame to be acked and replayed over.
    session.releaseAll();
    await session.step(120);
    faults.push(...health(session, beats, watch));

    const settled = session.tabs.map((tab) => settle(tab, session.server));
    const digest = digestOf(session.server);
    const scored = replicated(session.server.runtime) as Record<string, number>;

    // Everyone closes their tab. The authority notices on the next deliver, and what it holds
    // afterwards is the whole leak check.
    for (const tab of session.tabs) session.leave(tab);
    await session.step(120);
    const rt = session.server.runtime;

    return {
        tally,
        clicks,
        hits,
        peakTabs,
        orbsSpawned: orbsEverSeen.size,
        collected: scored[STATE_COLLECTED] ?? 0,
        walked: scored[STATE_WALKED] ?? 0,
        popped: scored[STATE_POPPED] ?? 0,
        ripened: scored[STATE_RIPENED] ?? 0,
        cooled: scored[STATE_COOLED] ?? 0,
        sweeps: scored[STATE_SWEEPS] ?? 0,
        faults,
        settled,
        digest,
        emptied: {
            players: rt.playerManager.players.length,
            orbs: orbsIn(rt).length,
            entities: templatesIn(rt).toSorted(),
            phase: gameField<string>(rt, STATE_PHASE) ?? '',
        },
    };
}

/** Picks an action nothing about the current session forbids. */
function draw(rng: SeededRandom, session: Session): Action {
    const live = session.tabs.length;
    const bag: Action[] = [];
    for (const [action, weight] of WEIGHTS) {
        if (live === 0 && action !== 'join' && action !== 'idle') continue;
        if (action === 'join' && live >= MAX_PLAYERS) continue;
        for (let i = 0; i < weight; i++) bag.push(action);
    }
    return rng.pick(bag);
}

/** A world point on some orb this tab can see, for the render layer to resolve back to an entity. */
function pickOrb(tab: Tab, rng: SeededRandom): { x: number; y: number } | undefined {
    if (tab.client.state !== 'live') return undefined;
    const rt = tab.client.mirror?.runtime;
    if (rt === undefined) return undefined;
    const orbs = orbsIn(rt);
    if (orbs.length === 0) return undefined;
    const orb = rng.pick(orbs);
    return { x: rt.transforms.posX(orb), y: rt.transforms.posY(orb) };
}

/**
 * What has already been reported, so a fault is named on the beat it happens and not on every beat
 * after it. The counters are cumulative and the logs only grow, so without this one throw at beat 5
 * would be six hundred lines.
 */
interface Watch {
    counters: Map<string, number>;
    logs: WeakMap<object, number>;
}

/** The counter's growth since the last beat. A drop means a new session reset it. */
function grew(watch: Watch, key: string, value: number): number {
    const before = watch.counters.get(key) ?? 0;
    watch.counters.set(key, value);
    return value > before ? value - before : 0;
}

/** The log records written since the last beat. */
function since<T>(watch: Watch, log: { records: ReadonlyArray<T> }): T[] {
    const from = watch.logs.get(log) ?? 0;
    watch.logs.set(log, log.records.length);
    return log.records.slice(from);
}

/**
 * Everything that must be true of every tab on every beat.
 *
 * Each line names the beat and the tab, so one failure out of six hundred beats is still a place to
 * start rather than a boolean.
 */
function health(session: Session, beat: number, watch: Watch): string[] {
    const faults: string[] = [];
    const at = `beat ${beat}`;

    for (const trip of session.trips) {
        faults.push(`${at}: the breaker disabled ${trip.scriptClass}.${trip.method}`);
    }
    session.trips.length = 0;
    // `droppedMarks` is deliberately not a fault here. It counts unrepresentable values AND marks
    // whose host died before the next send — and the second is ordinary in this game, where the
    // region pass reprices an orb that is then taken inside the same send interval.
    for (const record of since(watch, session.server.runtime.log)) {
        faults.push(`${at}: server ${record.scriptClass}.${record.method} — ${why(record)}`);
    }

    for (const tab of session.tabs) {
        const where = `${at}: ${tab.name}`;
        const stats = tab.client.stats();
        const count = (name: string, value: number): number =>
            grew(watch, `${tab.name}.${name}`, value);
        if (stats.state === 'failed') faults.push(`${where} failed: ${describeFailure(tab)}`);
        if (count('unknownNetId', stats.unknownNetId) > 0)
            faults.push(`${where} saw an unknown netId`);
        if (count('parent', stats.outOfOrderParent) > 0)
            faults.push(`${where} saw a child before its parent`);
        if (count('chunks', stats.snapshotChunksDropped) > 0)
            faults.push(`${where} dropped a snapshot chunk`);
        if (count('overflow', stats.droppedToOverflow) > 0)
            faults.push(`${where} overflowed its input ring`);
        if (count('assets', stats.assetLoadFailed) > 0)
            faults.push(`${where} failed an asset load`);
        if (stats.localTick < stats.depictedTick) {
            faults.push(
                `${where} is behind what it depicts: ${stats.localTick} < ${stats.depictedTick}`,
            );
        }

        const mirror = tab.client.mirror;
        if (mirror === undefined) continue;
        // `droppedAttach` is deliberately not here: this project links only the synced class into
        // the client half, so every avatar's server-located `Collector` reaches a browser as an
        // attach it holds no class for. That count is the split working, not a fault.
        const counters = mirror.counters;
        if (count('netId', counters.invalidNetId) > 0)
            faults.push(`${where} was sent an implausible netId`);
        if (count('list', counters.oversizedList) > 0)
            faults.push(`${where} was sent an oversized list`);

        for (const record of since(watch, mirror.runtime.log)) {
            faults.push(`${where} ${record.scriptClass}.${record.method} — ${why(record)}`);
        }

        const declared = new Set(PROJECT.templates.map((template) => template.id as string));
        for (const template of templatesIn(mirror.runtime)) {
            if (!declared.has(template)) faults.push(`${where} holds an undeclared ${template}`);
        }

        const player = tab.client.localPlayer;
        const avatar = player === null ? undefined : avatarIn(mirror.runtime, player.id);
        if (avatar === undefined) continue;
        // The clamp is inside the script both ends replay, so a predicted pose outside the world
        // is prediction running code the authority did not.
        const x = mirror.runtime.transforms.posX(avatar);
        const y = mirror.runtime.transforms.posY(avatar);
        if (x < WORLD.left || x > WORLD.right || y < WORLD.bottom || y > WORLD.top) {
            faults.push(`${where} predicted its avatar off the world at ${x},${y}`);
        }
    }
    return faults;
}

/** The throw's own first line: without it a fault names a handler and not what went wrong in it. */
function why(record: { event: string; stack: string }): string {
    return `${record.stack.split('\n')[0]?.trim() ?? 'threw'} (on ${record.event})`;
}

function describeFailure(tab: Tab): string {
    const failure = tab.client.lifecycle.failure;
    return failure === undefined ? 'for no stated reason' : failure.kind;
}

/** What one tab holds against what the authority holds, field by field. */
function settle(tab: Tab, server: GameServer): Settled {
    const rt = runtimeOf(tab);
    const player = tab.client.localPlayer;
    const mine = player?.id;
    const mirrored = mine === undefined ? undefined : avatarIn(rt, mine);
    const authoritative = mine === undefined ? undefined : avatarIn(server.runtime, mine);
    const counters = tab.client.prediction?.counters;

    return {
        name: tab.name,
        state: tab.client.state,
        avatar:
            mirrored === undefined || authoritative === undefined
                ? null
                : {
                      mirror: [rt.transforms.posX(mirrored), rt.transforms.posY(mirrored)],
                      server: [
                          server.runtime.transforms.posX(authoritative),
                          server.runtime.transforms.posY(authoritative),
                      ],
                  },
        orbs: { mirror: orbsIn(rt).length, server: orbsIn(server.runtime).length },
        game: { mirror: replicated(rt), server: replicated(server.runtime) },
        taken: {
            mirror: mine === undefined ? 0 : (playerField<number>(rt, mine, STATE_TAKEN) ?? 0),
            server:
                mine === undefined
                    ? 0
                    : (playerField<number>(server.runtime, mine, STATE_TAKEN) ?? 0),
        },
        leaked: server.runtime.playerManager.players
            .filter((other) => other.id !== mine)
            .flatMap((other) => {
                const seen = playerField<number>(rt, other.id, STATE_TAKEN);
                return seen === undefined ? [] : [`${other.id}=${seen}`];
            }),
        cappedReplays: counters?.cappedReplays ?? 0,
        resimulations: counters?.resimulations ?? 0,
        snappedCorrections: counters?.snappedCorrections ?? 0,
    };
}

/** The Game-hosted fields, which every peer is told and which therefore must agree. */
function replicated(rt: Runtime): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of [
        STATE_PHASE,
        STATE_PLAYERS,
        STATE_ORBS,
        STATE_COLLECTED,
        STATE_WALKED,
        STATE_POPPED,
        STATE_RIPENED,
        STATE_COOLED,
        STATE_SWEEPS,
    ]) {
        out[field] = gameField(rt, field);
    }
    return out;
}

/**
 * The authority's whole world as one string.
 *
 * Sorted by entity id rather than taken in table order, so the comparison is over what the world IS
 * and not over the order a particular run happened to allocate it in.
 */
function digestOf(server: GameServer): string {
    const rt = server.runtime;
    const lines: string[] = [];
    const ids = [...rt.entities.liveIds()].toSorted((a, b) => a - b);
    for (const id of ids) {
        const record = rt.entities.record(id);
        lines.push(
            [
                id,
                record?.template ?? '?',
                record?.ownerId ?? '-',
                fixed(rt.transforms.posX(id)),
                fixed(rt.transforms.posY(id)),
                fixed(rt.transforms.rotation(id)),
                fixed(rt.transforms.scale(id)),
                fixed(rt.transforms.opacity(id)),
                rt.transforms.layer(id),
            ].join('|'),
        );
    }
    lines.push(`game|${values(rt, GAME_KEY)}`);
    for (const player of rt.playerManager.players) {
        lines.push(`player|${player.id}|${player.name}|${values(rt, playerKey(player.id))}`);
    }
    return lines.join('\n');
}

function values(rt: Runtime, key: string): string {
    const held = rt.hosts.get(key)?.record.values;
    if (held === undefined) return '';
    return [...held.entries()]
        .map(([name, value]) => `${name}=${asText(value)}`)
        .toSorted()
        .join(',');
}

/** One replicated value as text. A wrapper goes through its own serializer, which is what the wire
 * and the checkpoint use — `String(...)` would render every scoreboard identical. */
function asText(value: unknown): string {
    if (typeof value === 'number') return fixed(value);
    const wrapper = value as { serialize?: () => unknown } | null;
    if (typeof wrapper?.serialize === 'function') return JSON.stringify(wrapper.serialize()) ?? '?';
    return JSON.stringify(value) ?? String(value);
}

function fixed(value: number): string {
    return value.toFixed(6);
}

describe('one seeded run of the whole platform', () => {
    let report: Report;

    beforeAll(async () => {
        report = await soak(SEED, BEATS);
    });

    it('drove the paths it claims to drive', () => {
        // Without this the checks below could all pass on a session where nothing ever happened.
        // Every bound is well under what this seed actually produces, so a retune of the weights
        // does not fail the suite while a path falling silent still does.
        expect(report.tally.join).toBeGreaterThan(8);
        expect(report.tally.leave).toBeGreaterThan(5);
        expect(report.peakTabs).toBe(MAX_PLAYERS);
        expect(report.orbsSpawned).toBeGreaterThan(60);
        expect(report.sweeps).toBeGreaterThan(2);
        // Both scoring routes, counted apart: an orb walked into is the collider pass and an orb
        // clicked is the whole pick path — a world point, the node drawn there, the entity behind
        // it, and the netId it goes out as. One standing in for the other would hide half of it.
        expect(report.walked).toBeGreaterThan(10);
        expect(report.popped).toBeGreaterThan(10);
        expect(report.collected).toBe(report.walked + report.popped);
        expect(report.hits).toBeGreaterThan(20);
        // Both edges of the region pass: orbs crossed into the bonus band, were repriced there, and
        // some lived long enough to leave it again.
        expect(report.ripened).toBeGreaterThan(20);
        expect(report.cooled).toBeGreaterThan(2);
        // Prediction ran, rather than every tab sitting in the state the server sent.
        expect(report.settled.some((tab) => tab.resimulations > 0)).toBe(true);
    });

    it('reports no fault, on any beat, from either end', () => {
        expect(report.faults).toEqual([]);
    });

    it('leaves every tab agreeing with the authority once the input stops', () => {
        expect(report.settled.length).toBe(MAX_PLAYERS);
        for (const tab of report.settled) {
            expect(tab.state).toBe('live');
            expect(tab.avatar).not.toBeNull();
            // Exactly, not nearly: the replay is the same arithmetic on the same inputs, so a
            // predicted avatar that has caught up sits on the authority's own number.
            expect(tab.avatar?.mirror).toEqual(tab.avatar?.server);
            expect(tab.orbs.mirror).toBe(tab.orbs.server);
            expect(tab.game.mirror).toEqual(tab.game.server);
            expect(tab.taken.mirror).toBe(tab.taken.server);
            // Host decides scope: a Player-hosted field reaches that player and no other tab.
            expect(tab.leaked).toEqual([]);
            // A replay that hit the ring cap skipped ticks the server simulated, which is the one
            // way this arrangement can silently diverge.
            expect(tab.cappedReplays).toBe(0);
            // Nothing in this world moves an avatar except the script both ends run, so a snap
            // means a tab predicted something the authority never agreed to.
            expect(tab.snappedCorrections).toBe(0);
        }
    });

    it('holds nothing but the placed world once the last tab closes', () => {
        expect(report.emptied.players).toBe(0);
        expect(report.emptied.orbs).toBe(0);
        expect(report.emptied.phase).toBe('idle');
        // Every avatar, every shadow and every orb is gone; what the project placed is what is left.
        expect(report.emptied.entities).toEqual([TEMPLATE_SHADOW]);
    });
});

describe('the same seed', () => {
    it('replays to the same world, and a different seed does not', async () => {
        const first = await soak(SEED, SHORT_BEATS);
        const second = await soak(SEED, SHORT_BEATS);
        // A world with entities, scores and a roster in it — an empty digest would match itself.
        expect(first.digest.split('\n').length).toBeGreaterThan(10);
        expect(second.digest).toBe(first.digest);
        expect(second.faults).toEqual([]);

        // The guard on the check above: two runs agreeing proves replay only if the digest could
        // have differed at all.
        const other = await soak(SEED + 1, SHORT_BEATS);
        expect(other.digest).not.toBe(first.digest);
    });
});

describe('a player who comes back', () => {
    it('reads their own totals back under the same identity, and a stranger gets nothing', async () => {
        const store = new MemoryKVStore();
        const first = newSession(store);
        const tab = await first.join('one', 'ada');
        await first.live(tab);
        // Long enough for the drop timer to have put orbs in front of a standing avatar.
        await first.stepUntil(() => scoreOn(first, tab) > 0, 900);
        const earned = scoreOn(first, tab);
        first.leave(tab);
        await first.step(30);
        first.dispose();

        // A second world over the same store, as a restarted process would be.
        const second = newSession(store);
        const back = await second.join('one', 'ada');
        const stranger = await second.join('two', 'zed');
        await second.live(back, stranger);
        await second.step(2);

        expect(lifetimeOn(second, back)).toBeGreaterThanOrEqual(earned);
        expect(lifetimeOn(second, stranger)).toBe(0);
        // Persisted is not resumed: the per-session count starts at zero however much is banked.
        expect(scoreOn(second, back)).toBe(0);
    });
});

/** This session's take, off the authority — the field a tab is told about only itself. */
function scoreOn(session: Session, tab: Tab): number {
    const id = tab.client.localPlayer?.id;
    if (id === undefined) return 0;
    return playerField<number>(session.server.runtime, id, STATE_TAKEN) ?? 0;
}

function lifetimeOn(session: Session, tab: Tab): number {
    const id = tab.client.localPlayer?.id;
    if (id === undefined) return 0;
    return playerField<number>(session.server.runtime, id, STATE_LIFETIME) ?? 0;
}
