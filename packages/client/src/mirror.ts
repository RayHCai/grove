// The mirror world: a real core runtime, the one path that writes it from the wire, and the passes a
// prediction step runs in it.
//
// A real runtime rather than typed arrays, because prediction needs one — snapshot/restore reach core's
// private stores, so a hand-rolled mirror would be thrown away to get it. Idle, every pass is a no-op:
// simulating is something the client may do only over an authoritative baseline it can rewind to.

import type { EntityId, Runtime, ScriptLocation, TickPasses } from '@platform/core';
import {
    GAME_KEY,
    Loop,
    entityKey,
    loadGame,
    playerKey,
    restoreHostField,
    Player,
} from '@platform/core';
import { clientPasses } from './passes.js';
import type { ClientPassContext } from './passes.js';
import type { Bounds } from '@platform/math';
import { bounds as makeBounds } from '@platform/math';
import type { ScriptId } from '@platform/project';
import type {
    EntitySnapshot,
    NetId,
    PlayerSnapshot,
    StateEnvelope,
    StateDiff,
    StateHostAddr,
    TransformEnvelope,
    Welcome,
    WireBounds,
    WireScriptAttachment,
    WireSingleStructuralOp,
    WireStructuralOp,
    WireTransform,
} from '@platform/protocol';
import { MAX_WIRE_ITEMS } from './constants.js';
import { MirrorIndex } from './index-map.js';

/** One applied reparent, in local handles. `parent` is null for a detach to the root. */
export interface MirrorReparent {
    local: EntityId;
    parent: EntityId | null;
}

/**
 * What a batch of applied ops changed, for the layers above to react to.
 *
 * Ordered, not sets: a batch can add and remove the same entity, and a set-union would create a node for a
 * dead entity or destroy one never created.
 */
export interface MirrorDelta {
    added: EntityId[];
    removed: EntityId[];
    /** Reparents, in journal order — the render tree cannot infer these from `added`/`removed`. */
    reparented: MirrorReparent[];
    joined: Player[];
    left: string[];
}

/** Counters for ops the mirror declined to apply. A nonzero count after a clean session is a bug. */
export interface MirrorCounters {
    /** An op naming a netId the mirror does not hold — a reconnect or interest-management race. */
    unknownNetId: number;
    /** A child applied before its parent, which the wire makes the server's obligation. */
    outOfOrderParent: number;
    /**
     * `attach` ops naming a `ScriptId` this process holds no class for.
     *
     * Zero is the healthy reading, and what the handshake's `projectHash` is for: both ends running
     * the same build means every id the authority names is one this bundle registered.
     */
    droppedAttach: number;
    /** A transform envelope superseded while held for its state envelope. */
    supersededTransforms: number;
    /** A spawn whose `netId` was not a plausible server handle, so it never entered the map. */
    invalidNetId: number;
}

/**
 * The read-only face the render bridge holds, so the layer that runs every frame cannot reach
 * `rt.transforms.setPosition` by accident.
 */
export interface MirrorView {
    readonly runtime: Runtime;
    readonly depictedTick: number;
    entityFor(netId: NetId): EntityId | undefined;
    netFor(local: EntityId): NetId | undefined;
    templateOf(local: EntityId): string;
    entries(): IterableIterator<[NetId, EntityId]>;
}

/** A creator script class, as the host holds one. */
export type ScriptClass = new () => object;

/**
 * The classes this process's bundle registered, by the id the wire names them with.
 *
 * Declared structurally rather than imported, so `@platform/scripting`'s `ScriptRegistry` satisfies
 * it without this package taking that dependency. It is the ONE table: the wire's `attach` op and a
 * spawn's overrides both name a `ScriptId`, so nothing here is keyed by template or by class name.
 */
export interface ScriptIndex {
    resolve(id: ScriptId): ScriptClass | undefined;
    /** Where the class runs. A `ServerScript` is filtered out of a client tick, so it is not attached. */
    locationOf(id: ScriptId): ScriptLocation | undefined;
}

/** What `Welcome` supplies that the mirror needs to build its runtime. */
export interface MirrorOptions {
    simRate: number;
    bounds: Bounds;
    regions: Array<{ name: string; bounds: Bounds }>;
    scripts?: ScriptIndex;
}

function emptyDelta(): MirrorDelta {
    return { added: [], removed: [], reparented: [], joined: [], left: [] };
}

/** Every pass a no-op, so a `step` taken without a baseline behind it moves nothing. */
function inertPasses(): TickPasses {
    return {
        starts() {},
        input() {},
        movement() {},
        contacts() {},
        regions() {},
        countdowns() {},
        update() {},
    };
}

export class Mirror {
    readonly #rt: Runtime;
    readonly #loop: Loop;
    readonly #index = new MirrorIndex();
    readonly #scripts: ScriptIndex | undefined;
    /** The table `loadGame` built, kept so simulating can install over it rather than rebuild it. */
    readonly #simPasses: TickPasses;
    /**
     * Where the server was in the state the wire last described.
     *
     * Its own field rather than `rt.tick`, which a prediction step moves to the local tick: the two agree
     * only while nothing is predicted, and the behind-check that catches a suspended tab reads this one.
     */
    #depictedTick = 0;
    /** Held until the `StateEnvelope` for the same tick lands — the join key is an equality. */
    #heldTransforms: TransformEnvelope | undefined;
    /** The highest tick whose state envelope has been applied; the snapshot stands in for its own. */
    #stateAppliedTick = -1;
    /** netIds whose teardown is queued; unmapped after `drainDestroyed` so the drain can read them. */
    readonly #pendingUnmap: NetId[] = [];

    readonly counters: MirrorCounters = {
        unknownNetId: 0,
        outOfOrderParent: 0,
        droppedAttach: 0,
        invalidNetId: 0,
        supersededTransforms: 0,
    };

    constructor(opts: MirrorOptions) {
        this.#scripts = opts.scripts;
        this.#rt = loadGame({
            role: 'client', // → ['client','synced'], rt.isServer = false
            simRate: opts.simRate,
            bounds: opts.bounds,
            regions: opts.regions,
            // gameScripts: deliberately absent — the MVP instantiates no creator code.
        });
        // No startGame(rt): it dispatches @onStart at every attached instance, and there are none.
        // Skipped rather than awaited — with an empty registry it would resolve immediately, and calling
        // it would read as though the client runs a lifecycle it does not have.
        this.#simPasses = this.#rt.passes ?? inertPasses();
        this.#rt.passes = inertPasses();
        this.#loop = new Loop(this.#rt);
    }

    get runtime(): Runtime {
        return this.#rt;
    }

    /** The loop a prediction step drives, and the `restore` that takes one back. */
    get loop(): Loop {
        return this.#loop;
    }

    /**
     * The depicted tick — where the server was in the state the wire last described.
     *
     * Distinct from the client's `localTick`, which is the input tick and ahead of it; the gap sawtooths,
     * so the only sound statement is `localTick >= depictedTick`.
     */
    get depictedTick(): number {
        return this.#depictedTick;
    }

    /**
     * Installs the passes a prediction step runs, or takes them back out.
     *
     * The one writer of `rt.passes` after construction, so what an idle mirror does — nothing — cannot be
     * changed from outside the file that documents it.
     */
    simulate(ctx: ClientPassContext | null): void {
        this.#rt.passes = ctx === null ? inertPasses() : clientPasses(this.#simPasses, ctx);
    }

    get index(): MirrorIndex {
        return this.#index;
    }

    view(): MirrorView {
        const rt = this.#rt;
        const depicted = (): number => this.#depictedTick;
        return {
            runtime: rt,
            get depictedTick(): number {
                return depicted();
            },
            entityFor: (netId) => this.#index.local(netId),
            netFor: (local) => this.#index.net(local),
            templateOf: (local) => this.templateOf(local),
            entries: () => this.#index.entries(),
        };
    }

    templateOf(local: EntityId): string {
        return this.#rt.entities.record(local)?.template ?? '';
    }

    /** The reliable envelope: structural journal, then `@serverState` diffs, then any held transform. */
    applyState(envelope: StateEnvelope): MirrorDelta {
        const delta = emptyDelta();

        // Both are set to the envelope's, never incremented: `rt.tick` is what the world believes the
        // time is, and the depicted tick is what the wire last said it was.
        this.#depictedTick = envelope.tick;
        this.#rt.tick = envelope.tick;

        // The ops do not commute, so this is a `for` loop and never a group-by-kind.
        for (const op of envelope.structural) {
            this.#applyStructural(op, delta);
        }

        // Once per envelope, not per op: core's destroy is teardown-at-end-of-tick and the client has no
        // tick to drain in, and a destroy-then-reparent of a sibling must still see a coherent child list.
        this.#rt.entityManager.drainDestroyed();
        for (const netId of this.#pendingUnmap) this.#index.delete(netId);
        this.#pendingUnmap.length = 0;

        // State after structural — `@serverState` on a newly spawned entity needs its host.
        for (const diff of envelope.state) this.#applyStateField(diff);

        this.#stateAppliedTick = envelope.tick;
        this.discardMarks();

        // Transform last, so it wins: the newest position information by construction.
        this.#releaseHeldTransforms(envelope.tick);

        return delta;
    }

    /** Holds the droppable envelope until its tick's state envelope lands; `tick` is the join key. */
    applyTransforms(envelope: TransformEnvelope): void {
        if (envelope.tick > this.#stateAppliedTick) {
            // Dropped, not queued: transform is droppable and the newer one is strictly better.
            if (this.#heldTransforms !== undefined) this.counters.supersededTransforms++;
            this.#heldTransforms = envelope;
            return;
        }
        this.#writeTransforms(envelope);
    }

    /**
     * The initial snapshot, through the same appliers — it is "spawn everything, set every field".
     *
     * Applied to a non-empty mirror this is a resync, which is what makes both the resync and prediction's
     * snap-back cheap.
     */
    applySnapshot(welcome: Welcome): MirrorDelta {
        const snapshot = welcome.snapshot;
        return this.applyState({
            kind: 'state',
            tick: snapshot.tick,
            ackSeq: 0,
            structural: [
                ...snapshot.players.map((player): WireStructuralOp => ({
                    kind: 'player-join',
                    player,
                })),
                // Parents before children is the server's obligation; the applier checks rather than
                // assuming, and counts a violation.
                ...snapshot.entities.map((entity): WireStructuralOp => ({
                    kind: 'spawn',
                    snapshot: entity,
                })),
            ],
            state: snapshot.state,
        });
    }

    /**
     * Empties the world for a resync: every entity destroyed, the roster dropped, the map cleared.
     *
     * The runtime is kept, so the fresh snapshot lands through the same path.
     */
    reset(): MirrorDelta {
        const delta = emptyDelta();
        for (const [, local] of this.#index.entries()) {
            if (!this.#rt.entities.isAlive(local)) continue;
            delta.removed.push(local);
            this.#rt.entityManager.destroy(local);
        }
        this.#index.clear();
        this.#rt.entityManager.drainDestroyed();

        for (const player of this.#rt.playerManager?.players ?? []) {
            delta.left.push(player.id);
            this.#rt.playerManager?.remove(player.id);
        }

        this.#heldTransforms = undefined;
        this.#stateAppliedTick = -1;
        this.#depictedTick = 0;
        this.#rt.tick = 0;
        // The dirty set is the bridge's queue, and `delta.removed` already destroys every node it names.
        this.discardMarks();
        return delta;
    }

    #applyStructural(op: WireStructuralOp, delta: MirrorDelta): void {
        if (op.kind === 'group') {
            // Verbatim and in order, exactly as the outer journal is: the boundary says these ops
            // are one instantiation, not that they may be reordered or applied selectively. Bounded
            // before the walk, since the count is peer-chosen and the work behind it is linear.
            if (op.ops.length > MAX_WIRE_ITEMS) return;
            for (const single of op.ops) this.#applySingle(single, delta);
            return;
        }
        this.#applySingle(op, delta);
    }

    #applySingle(op: WireSingleStructuralOp, delta: MirrorDelta): void {
        switch (op.kind) {
            case 'spawn':
            case 'enter-interest':
                // One applier for both: the same `EntitySnapshot`, both answering "here is an entity you
                // have not been watching".
                this.#spawn(op.snapshot, delta);
                return;

            case 'destroy':
            case 'leave-interest':
                // Interest is parent-closed, so a parent leaving never orphans a child still in view.
                this.#destroy(op.netId, delta);
                return;

            case 'reparent': {
                const local = this.#resolve(op.netId);
                if (local === undefined) return;
                const entity = this.#rt.entityManager.facade(local);
                if (op.parent === null) {
                    entity.detach();
                    delta.reparented.push({ local, parent: null });
                    return;
                }
                const parent = this.#resolve(op.parent);
                if (parent === undefined) return;
                entity.attachTo(this.#rt.entityManager.facade(parent));
                delta.reparented.push({ local, parent });
                return;
            }

            case 'tag': {
                const local = this.#resolve(op.netId);
                if (local === undefined) return;
                const entity = this.#rt.entityManager.facade(local);
                if (op.added) entity.tag(op.tag);
                else entity.untag(op.tag);
                return;
            }

            case 'player-join':
                delta.joined.push(this.#joinPlayer(op.player));
                return;

            case 'player-leave': {
                // The server must emit this after the destroys of that player's entities: journal order is
                // meaning, and leave-first would null `entity.owner` before anyone is told about the avatar.
                if (this.#rt.playerManager?.byId(op.id) == null) {
                    this.counters.unknownNetId++;
                    return;
                }
                this.#rt.playerManager.remove(op.id);
                this.#rt.hosts.remove(playerKey(op.id));
                delta.left.push(op.id);
                return;
            }

            case 'attach': {
                const local = this.#resolve(op.netId);
                if (local === undefined) return;
                this.#attach(local, op);
                return;
            }

            default: {
                // `noImplicitReturns` is off, so an arm added to the union without one here would
                // fall through and no-op in silence — the shape of the bug this whole file counts.
                const unreachable: never = op;
                return unreachable;
            }
        }
    }

    #spawn(snapshot: EntitySnapshot, delta: MirrorDelta): void {
        // The only place a peer-chosen netId enters the map, so the only place it has to be plausible:
        // a fractional or negative one could never name a server handle, and would key an entry no
        // later op can address.
        if (!Number.isSafeInteger(snapshot.netId) || snapshot.netId < 0) {
            this.counters.invalidNetId++;
            return;
        }
        const t = snapshot.transform;
        const entity = this.#rt.entityManager.spawn(
            snapshot.template,
            t.posX,
            t.posY,
            snapshot.owner ?? '',
        );
        const local = entity.entityId;
        this.#index.set(snapshot.netId, local);

        if (snapshot.parent !== null) {
            const parent = this.#resolve(snapshot.parent);
            if (parent === undefined) {
                // Rooted AND counted: a wire requirement no receiver checks quietly stops holding, and a
                // silently rooted child is the flat-world bug arriving through ordering.
                this.counters.outOfOrderParent++;
            } else {
                entity.attachTo(this.#rt.entityManager.facade(parent));
            }
        }

        for (const tag of snapshot.tags) entity.tag(tag);
        // Before the state diffs of this same envelope: attaching hoists `@serverState` onto the host
        // record, and the wire's values have to land on the hoisted accessors rather than under them.
        for (const attachment of snapshot.overrides?.scripts ?? []) {
            this.#attach(local, attachment);
        }
        // `spawn` sets position only, so a wall authored at scale 3 on layer 2 would render at scale 1 on
        // layer 0 forever — a static entity is dirty exactly once.
        this.#writeTransform(local, t);
        delta.added.push(local);
    }

    /**
     * Attaches one script named by the wire, or counts the miss.
     *
     * A `ServerScript` is skipped rather than counted: the authority runs it and a client tick
     * filters it out of every dispatch, so attaching it here would build an instance nothing could
     * ever reach. A location this process cannot name at all is a class it does not hold, which is
     * the miss the counter is for.
     */
    #attach(local: EntityId, attachment: WireScriptAttachment): void {
        const registry = this.#scripts;
        if (registry === undefined) {
            this.counters.droppedAttach++;
            return;
        }
        if (registry.locationOf(attachment.script) === 'server') return;
        const klass = registry.resolve(attachment.script);
        if (klass === undefined) {
            this.counters.droppedAttach++;
            return;
        }
        this.#rt.wiring?.attachToEntity(local, klass as never, attachment.props);
    }

    #destroy(netId: NetId, delta: MirrorDelta): void {
        const local = this.#resolve(netId);
        if (local === undefined) return;
        delta.removed.push(local);
        this.#rt.entityManager.destroy(local);
        this.#pendingUnmap.push(netId);
    }

    #joinPlayer(snapshot: PlayerSnapshot): Player {
        const existing = this.#rt.playerManager?.byId(snapshot.id);
        if (existing) {
            existing.name = snapshot.name;
            return existing;
        }
        // Minted directly, not through core's `joinPlayer`, which dispatches @onPlayerJoin — the server's
        // authority. `index` comes from the wire, so a mid-session joiner does not renumber the roster.
        const player = new Player(this.#rt, snapshot.id, snapshot.index, snapshot.name);
        this.#rt.playerManager?.adopt(player);
        this.#rt.hosts.ensure(playerKey(snapshot.id));
        return player;
    }

    /**
     * Writes the host record directly: with no scripts there is no accessor to hoist onto, and
     * `channels.markState` would mark a channel with no consumer.
     *
     * Attaching a `ClientScript` later hoists onto this same record, which is why it is not a parallel map.
     *
     * Through core's own `restoreHostField` rather than a bare `set`, because a wrapper field's value
     * is a wrapper: assigning the decoded payload over one would leave a methodless object where a
     * `Scoreboard` was, and a client holding none needs one built from the payload's tag.
     */
    #applyStateField(diff: StateDiff): void {
        const key = this.#hostKey(diff.host);
        if (key === undefined) return;
        const fields = diff.fields;
        if (typeof fields !== 'object' || fields === null) return;
        const record = this.#rt.hosts.ensure(key).record;
        for (const [field, value] of Object.entries(fields)) {
            restoreHostField(record, field, value);
        }
    }

    /**
     * Built with core's own helpers: `hosts.ensure` mints a record for any key without validating, so an
     * unprefixed one silently creates a second, empty record every write lands in.
     */
    #hostKey(host: StateHostAddr): string | undefined {
        switch (host.kind) {
            case 'game':
                return GAME_KEY;
            case 'player':
                return playerKey(host.id);
            case 'entity': {
                const local = this.#resolve(host.netId);
                // The full packed local EntityId, not the slot index.
                return local === undefined ? undefined : entityKey(local as number);
            }
        }
    }

    #releaseHeldTransforms(tick: number): void {
        const held = this.#heldTransforms;
        if (held === undefined || held.tick > tick) return;
        this.#heldTransforms = undefined;
        this.#writeTransforms(held);
    }

    #writeTransforms(envelope: TransformEnvelope): void {
        for (const diff of envelope.transform) {
            const local = this.#resolve(diff.netId);
            if (local === undefined) continue;
            this.#writeTransform(local, diff);
        }
    }

    #writeTransform(local: EntityId, t: WireTransform): void {
        const transforms = this.#rt.transforms;
        transforms.setPosition(local, t.posX, t.posY, t.posZ);
        transforms.setRotation(local, t.rot);
        transforms.setScale(local, t.scale);
        transforms.setOpacity(local, t.opacity);
        transforms.setLayer(local, t.layer);
    }

    /**
     * Core's facades mark channels the client has no consumer for; left alone the journal grows for the
     * session (3000 marks over 1000 apply cycles). A predicted tick marks them too, so it calls this.
     *
     * Safe here specifically because `clear()` does not reach the transform dirty set — that lives on
     * `SimTransformStore`, not `ReplicationChannels`, and wiping it would drop a frame's movement.
     */
    discardMarks(): void {
        this.#rt.channels.clear();
    }

    /** Dropped and counted, never thrown: a destroy for something already gone is ordinary. */
    #resolve(netId: NetId): EntityId | undefined {
        const local = this.#index.local(netId);
        if (local === undefined) {
            this.counters.unknownNetId++;
            return undefined;
        }
        return local;
    }
}

/** `WireBounds` → math's `Bounds`. Structurally identical; restated on the wire. */
export function wireBounds(b: WireBounds): Bounds {
    return makeBounds(b.left, b.right, b.top, b.bottom);
}
