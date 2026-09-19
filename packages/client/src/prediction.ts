// A server delta lands on the authoritative baseline, never on a predicted pose: a delta names only
// what changed, so anything it omits would keep its predicted value forever.

import type {
    ActionStates,
    EntityId,
    Player,
    Runtime,
    Snapshot,
    SnapshotStore,
} from '@platform/core';
import { GAME_KEY, createActionStates, entityKey, playerKey } from '@platform/core';
import type { InputFrame } from '@platform/protocol';
import type { RenderBridge } from './bridge.js';
import { CORRECTION_SNAP_DISTANCE_SQUARED, MAX_REPLAY_TICKS } from './constants.js';
import type { Mirror } from './mirror.js';
import type { ClientPassContext } from './passes.js';
import type { InputRing } from './ring.js';
import { assertHeld } from './ring.js';

/** What a dev console asks of the predicted half; a rising `cappedReplays` means falling behind. */
export interface PredictionCounters {
    /** Ticks handed to `step`, first-time and re-simulated alike. */
    steppedTicks: number;
    /** Rewind-and-replay cycles: one per frame that carried authoritative state. */
    resimulations: number;
    /** Replays that hit `MAX_REPLAY_TICKS`, so ticks the server did simulate were skipped here. */
    cappedReplays: number;
    /** Corrections shown at once, the server having moved an entity too far for easing to hide. */
    snappedCorrections: number;
}

/** One entity's pre-rewind pose, kept to measure what the authority disagreed with. */
interface Pose {
    x: number;
    y: number;
    z: number;
}

export interface PredictionOptions {
    mirror: Mirror;
    ring: InputRing;
    bridge: RenderBridge;
    /** The local player, as `Welcome` named them. */
    playerId: string;
}

export class Prediction {
    readonly #mirror: Mirror;
    readonly #ring: InputRing;
    readonly #bridge: RenderBridge;
    readonly #rt: Runtime;
    readonly #playerId: string;

    /** The authoritative world, refilled in place; `Loop.snapshot` would mint a buffer per call. */
    readonly #entries: Array<{ store: SnapshotStore; buffer: unknown }> = [];
    #baselineTick = -1;

    readonly #state: StateBaseline;

    /** The entities this client simulates: the local player's own, refreshed on change. */
    readonly #scope = new Set<EntityId>();
    readonly #liveIds: EntityId[] = [];

    /** The fold a replay runs on, seeded from the ring's horizon — never the client's live one. */
    #actions: ActionStates = createActionStates();

    /** The highest tick stepped; ticks at or below it re-simulate and suppress client handlers. */
    #highestSimulated = -1;
    /** Where the predicted world stands, or -1 when nothing is predicted over the baseline. */
    #predictedTick = -1;

    readonly #poses = new Map<EntityId, Pose>();
    readonly #frames: InputFrame[] = [];
    readonly #matches: InputFrame[] = [];

    readonly counters: PredictionCounters = {
        steppedTicks: 0,
        resimulations: 0,
        cappedReplays: 0,
        snappedCorrections: 0,
    };

    /** The seams the mirror's passes resolve per tick. Built once and held for the session. */
    readonly context: ClientPassContext;

    constructor(opts: PredictionOptions) {
        this.#mirror = opts.mirror;
        this.#ring = opts.ring;
        this.#bridge = opts.bridge;
        this.#playerId = opts.playerId;
        this.#rt = opts.mirror.runtime;
        this.#state = new StateBaseline(this.#rt);
        this.context = {
            rt: this.#rt,
            // Resolved per call, never captured: the fold is replaced on every reseed.
            actions: () => this.#actions,
            player: () => this.#player(),
            scope: () => this.#scope,
            frameFor: (tick) => this.#frameFor(tick),
        };
    }

    /** Where the predicted world stands, or -1 while nothing is predicted over the baseline. */
    get predictedTick(): number {
        return this.#predictedTick;
    }

    get scope(): ReadonlySet<EntityId> {
        return this.#scope;
    }

    /** Undoes prediction so the authoritative write lands on authoritative state. Idempotent. */
    rewind(): void {
        // Cleared even with nothing to take back: a pose describes the rewind that recorded it.
        this.#poses.clear();
        if (this.#predictedTick < 0 || this.#baselineTick < 0) return;
        this.#recordPoses();
        // Restores the registered stores, resets `rt.tick`, and kills invocations newer than the
        // baseline so a timer a predicted tick started does not survive the tick that started it.
        this.#mirror.loop.restore(this.#snapshot());
        this.#state.restore();
        this.#remarkDirty();
        this.#predictedTick = -1;
    }

    /** Simulates up to `localTick`; `resimulate` retakes the baseline and re-runs unacked. */
    advance(localTick: number, resimulate: boolean): void {
        if (resimulate) {
            this.#refreshScope();
            this.#capture();
            this.#seedActions();
            this.#predictedTick = this.#mirror.depictedTick;
            this.counters.resimulations++;
        }
        if (this.#predictedTick < 0) return;

        this.#ring.frames(this.#frames);

        let from = this.#predictedTick + 1;
        if (localTick - from >= MAX_REPLAY_TICKS) {
            // A span past the ring is a client that has been away; re-running costs a late frame.
            from = localTick - MAX_REPLAY_TICKS + 1;
            this.counters.cappedReplays++;
        }
        for (let tick = from; tick <= localTick; tick++) this.#step(tick);
        if (localTick > this.#predictedTick) this.#predictedTick = localTick;

        if (resimulate) this.#measureCorrections();
        // Predicted ops mark channels nothing here drains; left alone the journal grows.
        this.#mirror.discardMarks();
    }

    #step(tick: number): void {
        const replay = tick <= this.#highestSimulated;
        this.#mirror.loop.step(tick, { replay, scope: this.#scope });
        if (tick > this.#highestSimulated) this.#highestSimulated = tick;
        this.counters.steppedTicks++;
    }

    #player(): Player | null {
        return this.#rt.playerManager?.byId(this.#playerId) ?? null;
    }

    /** Ownership is the client's only handle on its own entities; `ownerId` names the player. */
    #refreshScope(): void {
        this.#scope.clear();
        this.#rt.entities.liveIds(this.#liveIds);
        for (const id of this.#liveIds) {
            if (this.#rt.entities.record(id)?.ownerId === this.#playerId) this.#scope.add(id);
        }
    }

    #capture(): void {
        if (this.#entries.length === 0) {
            for (const store of this.#rt.registry.stores) {
                this.#entries.push({ store, buffer: store.createBuffer() });
            }
        }
        for (const entry of this.#entries) entry.store.capture(entry.buffer, this.#scope);
        this.#baselineTick = this.#mirror.depictedTick;
        this.#state.capture(this.#stateHosts());
    }

    #snapshot(): Snapshot {
        return { tick: this.#baselineTick, scope: this.#scope, entries: this.#entries };
    }

    /** The hosts a predicted tick may write: the game, the local player, and what they own. */
    *#stateHosts(): IterableIterator<string> {
        yield GAME_KEY;
        yield playerKey(this.#playerId);
        for (const id of this.#scope) yield entityKey(id);
    }

    /** Seeds the replay's fold: the horizon, then every frame the authority already simulated. */
    #seedActions(): void {
        const actions = createActionStates();
        assertHeld(this.#ring.heldAtHorizon, actions);

        const depicted = this.#mirror.depictedTick;
        this.#ring.frames(this.#frames);
        for (const frame of this.#frames) {
            if (frame.tick > depicted) break;
            actions.advanceTick();
            for (const action of frame.actions) actions.applyEdge(action);
        }
        this.#actions = actions;
    }

    /** Scanned rather than indexed: the ring is bounded, and one flush can stamp two frames. */
    #frameFor(tick: number): InputFrame | undefined {
        this.#matches.length = 0;
        for (const frame of this.#frames) if (frame.tick === tick) this.#matches.push(frame);
        return this.#matches.length === 1 ? this.#matches[0] : this.#merged();
    }

    /** Two frames on one tick both apply, in send order — as the authority drains them. */
    #merged(): InputFrame | undefined {
        const first = this.#matches[0];
        if (first === undefined) return undefined;
        const actions = this.#matches.flatMap((frame) => frame.actions);
        return { ...first, actions };
    }

    /** The pose on screen: the simulated one plus whatever is still easing. */
    #recordPoses(): void {
        const transforms = this.#rt.transforms;
        for (const id of this.#scope) {
            if (!this.#rt.entities.isAlive(id)) continue;
            const drawn = this.#bridge.correctionOf(id);
            this.#poses.set(id, {
                x: transforms.posX(id) + drawn.x,
                y: transforms.posY(id) + drawn.y,
                z: transforms.posZ(id) + drawn.z,
            });
        }
    }

    /** What the authority disagreed with, handed to the display and never to the simulation. */
    #measureCorrections(): void {
        const transforms = this.#rt.transforms;
        for (const [id, pose] of this.#poses) {
            if (!this.#rt.entities.isAlive(id)) continue;
            const dx = pose.x - transforms.posX(id);
            const dy = pose.y - transforms.posY(id);
            const dz = pose.z - transforms.posZ(id);
            const distance = dx * dx + dy * dy + dz * dz;
            if (distance === 0) continue;
            if (distance > CORRECTION_SNAP_DISTANCE_SQUARED) {
                // Easing a teleport draws a slide the simulation never made.
                this.#bridge.clearCorrection(id);
                this.counters.snappedCorrections++;
                continue;
            }
            this.#bridge.correct(id, dx, dy, dz);
        }
        this.#poses.clear();
    }

    /** A restore marks nothing dirty, and the dirty set is the bridge's work queue — mark here. */
    #remarkDirty(): void {
        const transforms = this.#rt.transforms;
        for (const id of this.#scope) {
            if (!this.#rt.entities.isAlive(id)) continue;
            transforms.setPosition(
                id,
                transforms.posX(id),
                transforms.posY(id),
                transforms.posZ(id),
            );
        }
    }
}

/** The `@serverState` half of the baseline, which core's snapshot registry does not carry. */
class StateBaseline {
    readonly #rt: Runtime;
    /** One buffer per host key, refilled in place — a capture runs at send rate. */
    readonly #buffers = new Map<string, Map<string, unknown>>();
    readonly #captured: string[] = [];
    /** This capture's keys, so the table is pruned to them rather than growing with the session. */
    readonly #live = new Set<string>();

    constructor(rt: Runtime) {
        this.#rt = rt;
    }

    capture(keys: Iterable<string>): void {
        this.#captured.length = 0;
        this.#live.clear();
        for (const key of keys) {
            // `get`, never `ensure`: minting here creates an empty record per stateless host.
            const values = this.#rt.hosts.get(key)?.record.values;
            if (values === undefined) continue;
            let buffer = this.#buffers.get(key);
            if (buffer === undefined) {
                buffer = new Map();
                this.#buffers.set(key, buffer);
            }
            buffer.clear();
            for (const [field, value] of values) buffer.set(field, value);
            this.#captured.push(key);
            this.#live.add(key);
        }

        // An entity key carries the slot's generation, so a respawn never reuses one — without
        // this the table holds a buffer per entity ever owned.
        for (const key of this.#buffers.keys()) {
            if (!this.#live.has(key)) this.#buffers.delete(key);
        }
    }

    /** Cleared and refilled, never merged; the record survives for later-hoisted accessors. */
    restore(): void {
        for (const key of this.#captured) {
            const buffer = this.#buffers.get(key);
            const values = this.#rt.hosts.get(key)?.record.values;
            if (buffer === undefined || values === undefined) continue;
            values.clear();
            for (const [field, value] of buffer) values.set(field, value);
        }
    }
}
