// Prediction: the rewind to the authoritative baseline, the replay of unacked input over it, and the
// correction the display eases rather than snaps.
//
// The mirror holds predicted state, so the render path needs no second source. What the baseline holds is
// the authoritative world, and a server delta is applied on top of THAT, never on top of a predicted pose:
// a delta names only what changed, so anything it does not mention would keep its predicted value forever.

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

/** What a dev console asks of the predicted half. A rising `cappedReplays` is a client falling behind. */
export interface PredictionCounters {
    /** Ticks handed to `step`, first-time and re-simulated alike. */
    steppedTicks: number;
    /** Rewind-and-replay cycles: one per frame that carried authoritative state. */
    resimulations: number;
    /** Replays that hit `MAX_REPLAY_TICKS`, so ticks the server did simulate were skipped here. */
    cappedReplays: number;
    /** Corrections shown at once, the server having moved an entity further than easing may hide. */
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

    /**
     * The authoritative world, refilled in place.
     *
     * `Loop.snapshot` mints a buffer per store per call, and one of them is seven typed arrays sized to
     * the entity count — at send rate that is garbage measured in hundreds of kilobytes a second. The
     * store interface exists to refill a caller-owned buffer, so this holds them and re-captures into them.
     */
    readonly #entries: Array<{ store: SnapshotStore; buffer: unknown }> = [];
    #baselineTick = -1;

    readonly #state: StateBaseline;

    /** The entities this client simulates: the local player's own, refreshed when structure changes. */
    readonly #scope = new Set<EntityId>();
    readonly #liveIds: EntityId[] = [];

    /** The fold a replay runs on, seeded from the ring's horizon — never the client's live one. */
    #actions: ActionStates = createActionStates();

    /** The highest tick stepped; ticks at or below it are re-simulations, and suppress client handlers. */
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

    /** The seams the mirror's passes resolve per tick. Built once — the passes hold it for the session. */
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
            // Resolved per call, never captured: the fold is replaced on every reseed and the roster
            // fills after the join.
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

    /**
     * Undoes prediction, so the authoritative write that follows lands on authoritative state.
     *
     * Idempotent within a batch: once the predicted world is gone there is nothing to take back, and a
     * second restore would rewind the delta the first one made room for.
     */
    rewind(): void {
        // Cleared even when there is nothing to take back: a pose describes the rewind that recorded it,
        // and a later measurement paired with an older one eases against a pose nobody was shown.
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

    /**
     * Simulates up to `localTick`.
     *
     * `resimulate` says authoritative state landed this frame: the baseline is retaken and the whole
     * unacked span re-runs. Without it the world is only carried forward onto the ticks the clock just
     * produced — re-running settled ticks every frame would fire each synced handler's effects again.
     */
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
            // A span past the ring is a client that has been away; re-running it costs a frame that is
            // already late, and the ticks it skips are the ones furthest from what is on screen.
            from = localTick - MAX_REPLAY_TICKS + 1;
            this.counters.cappedReplays++;
        }
        for (let tick = from; tick <= localTick; tick++) this.#step(tick);
        if (localTick > this.#predictedTick) this.#predictedTick = localTick;

        if (resimulate) this.#measureCorrections();
        // Predicted ops mark channels nothing here drains; left alone the journal grows for the session.
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

    /**
     * Ownership is the client's only handle on its own entities: nothing here fills a `Player`'s avatar,
     * and `ownerId` is the one field a spawn carries that names a player.
     */
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

    /** The hosts a predicted tick may write: the game, the local player, and what that player owns. */
    *#stateHosts(): IterableIterator<string> {
        yield GAME_KEY;
        yield playerKey(this.#playerId);
        for (const id of this.#scope) yield entityKey(id);
    }

    /**
     * Seeds the replay's fold: the horizon, then every frame the authority has already simulated.
     *
     * The horizon is an interval, not a tick — it is valid from the last pruned frame until the oldest
     * unacked one — so the frames between it and the depicted tick are folded rather than replayed.
     */
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

    /** Scanned rather than indexed: the ring is bounded, and one flush can stamp two frames on a tick. */
    #frameFor(tick: number): InputFrame | undefined {
        this.#matches.length = 0;
        for (const frame of this.#frames) if (frame.tick === tick) this.#matches.push(frame);
        return this.#matches.length === 1 ? this.#matches[0] : this.#merged();
    }

    /** Two frames on one tick both applied, in send order — the authority drains them the same way. */
    #merged(): InputFrame | undefined {
        const first = this.#matches[0];
        if (first === undefined) return undefined;
        const actions = this.#matches.flatMap((frame) => frame.actions);
        return { ...first, actions };
    }

    /**
     * The pose on screen, which is the simulated one plus whatever is still easing.
     *
     * The residual belongs in the measurement: an offset replaces rather than accumulates, so a
     * correction measured from the bare simulated pose would discard the ease still in flight and jump
     * the drawn position by it — once per authoritative envelope, which is the correction it replaces.
     */
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

    /**
     * What the authority disagreed with, handed to the display and never to the simulation.
     *
     * The offset carries the pose the player was already looking at and decays to nothing, so the
     * correction is a fraction of a second of easing rather than a jump — while the simulation keeps
     * the server's exact answer, which is the only value an input replays against.
     */
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

    /**
     * A restore writes the transform arrays directly and marks nothing dirty, and the dirty set is the
     * render bridge's whole work queue — so a rewind the replay does not happen to overwrite would stay
     * on screen at the pose it just discarded.
     */
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

/**
 * The `@serverState` half of the baseline, which core's snapshot registry does not carry.
 *
 * Scoped like everything else here: the game, the local player, and the entities that player owns are the
 * hosts a predicted tick may write, and a host table offers no way to enumerate the rest.
 */
class StateBaseline {
    readonly #rt: Runtime;
    /** One buffer per host key, refilled in place — a capture runs at send rate. */
    readonly #buffers = new Map<string, Map<string, unknown>>();
    readonly #captured: string[] = [];
    /** This capture's keys, so the table can be pruned to them rather than growing with the session. */
    readonly #live = new Set<string>();

    constructor(rt: Runtime) {
        this.#rt = rt;
    }

    capture(keys: Iterable<string>): void {
        this.#captured.length = 0;
        this.#live.clear();
        for (const key of keys) {
            // `get`, never `ensure`: minting a record here would create an empty one, and a scope with
            // it, for every host that has no state at all.
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

        // An entity key carries the slot's generation, so a respawn never reuses one — without this the
        // table holds a buffer per entity the player has ever owned, for the life of the session.
        for (const key of this.#buffers.keys()) {
            if (!this.#live.has(key)) this.#buffers.delete(key);
        }
    }

    /**
     * Cleared and refilled, never merged: a field a predicted tick added is absent from the buffer, and a
     * merge would leave it behind. The record object itself survives, because a script attached later
     * hoists its accessors onto that identity.
     */
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
