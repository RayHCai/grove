// A real core runtime rather than typed arrays, because prediction needs its snapshot/restore.

import type { AnyScriptClass, EntityId, Runtime, ScriptLocation, TickPasses } from '@platform/core';
import {
    GAME_KEY,
    Loop,
    entityKey,
    loadGame,
    playerKey,
    hoistReplicated,
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
import { MAX_ENTITY_SCRIPTS, MAX_WIRE_ITEMS } from './constants.js';
import { MirrorIndex } from './index-map.js';

/** One applied reparent, in local handles. `parent` is null for a detach to the root. */
export interface MirrorReparent {
    local: EntityId;
    parent: EntityId | null;
}

/** What a batch of applied ops changed, for the layers above. Ordered, not sets. */
export interface MirrorDelta {
    added: EntityId[];
    removed: EntityId[];
    /** Reparents, in journal order — the render tree cannot infer these from `added`/`removed`. */
    reparented: MirrorReparent[];
    joined: Player[];
    left: string[];
}

/** Counters for ops the mirror declined to apply; nonzero after a clean session is a bug. */
export interface MirrorCounters {
    /** An op naming a netId the mirror does not hold — a reconnect or interest-management race. */
    unknownNetId: number;
    /** A child applied before its parent, which the wire makes the server's obligation. */
    outOfOrderParent: number;
    /** `attach` ops naming a `ScriptId` this process holds no class for; zero is healthy. */
    droppedAttach: number;
    /** A transform envelope superseded while held for its state envelope. */
    supersededTransforms: number;
    /** A spawn whose `netId` was not a plausible server handle, so it never entered the map. */
    invalidNetId: number;
    /** An array from the wire past the cap for its kind, refused whole before the element walk. */
    oversizedList: number;
    /** A `StateDiff` field whose name the host facade already answers to; never hoisted. */
    reservedField: number;
}

/** The read-only face the render bridge holds, so it cannot reach `setPosition` by accident. */
export interface MirrorView {
    readonly runtime: Runtime;
    readonly depictedTick: number;
    entityFor(netId: NetId): EntityId | undefined;
    netFor(local: EntityId): NetId | undefined;
    templateOf(local: EntityId): string;
    entries(): IterableIterator<[NetId, EntityId]>;
}

/** A creator script class, as the host holds one — core's shape, so an attach needs no cast. */
export type ScriptClass = AnyScriptClass;

/** The bundle's classes by wire id; structural, so `ScriptRegistry` fits with no dependency. */
export interface ScriptIndex {
    resolve(id: ScriptId): ScriptClass | undefined;
    /** Where the class runs; a `ServerScript` is filtered from a client tick, so never attached. */
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
    /** The table `loadGame` built, kept so simulating installs over it rather than rebuilding. */
    readonly #simPasses: TickPasses;
    /** Where the server was when the wire last described it; not `rt.tick`, moved by prediction. */
    #depictedTick = 0;
    /** Held until the `StateEnvelope` for the same tick lands — the join key is an equality. */
    #heldTransforms: TransformEnvelope | undefined;
    /** Highest tick whose state envelope has been applied; the snapshot stands in for its own. */
    #stateAppliedTick = -1;
    /** netIds whose teardown is queued; unmapped after `drainDestroyed` so the drain reads them. */
    readonly #pendingUnmap: NetId[] = [];

    readonly counters: MirrorCounters = {
        unknownNetId: 0,
        outOfOrderParent: 0,
        droppedAttach: 0,
        invalidNetId: 0,
        supersededTransforms: 0,
        oversizedList: 0,
        reservedField: 0,
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
        // No `startGame(rt)`: it dispatches `@onStart`, and nothing is attached here.
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

    /** The depicted tick. Distinct from `localTick`, which is ahead; the gap sawtooths. */
    get depictedTick(): number {
        return this.#depictedTick;
    }

    /** Installs or removes the passes a prediction step runs. The one writer of `rt.passes`. */
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

    /** The reliable envelope: structural journal, then `@serverState` diffs, then transform. */
    applyState(envelope: StateEnvelope): MirrorDelta {
        const delta = emptyDelta();

        // Both set to the envelope's, never incremented: `rt.tick` is what the world believes.
        this.#depictedTick = envelope.tick;
        this.#rt.tick = envelope.tick;

        // The ops do not commute, so this is a `for` loop and never a group-by-kind.
        for (const op of envelope.structural) {
            this.#applyStructural(op, delta);
        }

        // Once per envelope, not per op: core destroys at end-of-tick and there is no tick here.
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

    /** Holds the droppable envelope until its tick's state envelope lands; `tick` is the key. */
    applyTransforms(envelope: TransformEnvelope): void {
        if (envelope.tick > this.#stateAppliedTick) {
            // Dropped, not queued: transform is droppable and the newer one is strictly better.
            if (this.#heldTransforms !== undefined) this.counters.supersededTransforms++;
            this.#heldTransforms = envelope;
            return;
        }
        this.#writeTransforms(envelope);
    }

    /** The initial snapshot through the same appliers; on a non-empty mirror this is a resync. */
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
                // Parents before children is the server's job; this checks and counts a violation.
                ...snapshot.entities.map((entity): WireStructuralOp => ({
                    kind: 'spawn',
                    snapshot: entity,
                })),
            ],
            state: snapshot.state,
        });
    }

    /** Empties the world for a resync; the runtime is kept for the fresh snapshot. */
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
        // The dirty set is the bridge's queue, and `delta.removed` already destroys the nodes.
        this.discardMarks();
        return delta;
    }

    #applyStructural(op: WireStructuralOp, delta: MirrorDelta): void {
        if (op.kind === 'group') {
            // Verbatim and in order, exactly as the outer journal is: the boundary says these ops
            // are one instantiation, not that they may be reordered or applied selectively. Bounded
            // before the walk, since the count is peer-chosen and the work behind it is linear.
            if (op.ops.length > MAX_WIRE_ITEMS) {
                this.counters.oversizedList++;
                return;
            }
            for (const single of op.ops) this.#applySingle(single, delta);
            return;
        }
        this.#applySingle(op, delta);
    }

    #applySingle(op: WireSingleStructuralOp, delta: MirrorDelta): void {
        switch (op.kind) {
            case 'spawn':
            case 'enter-interest':
                // One applier for both: the same `EntitySnapshot` either way.
                this.#spawn(op.snapshot, delta);
                return;

            case 'destroy':
            case 'leave-interest':
                // Interest is parent-closed, so a parent leaving never orphans a child in view.
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
                // The server must emit this after that player's destroys: leave-first would null
                // `entity.owner` before anyone is told about the avatar.
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
        // The only place a peer-chosen netId enters the map, so the only place it must be sane:
        // a fractional or negative one could never name a server handle.
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
                // Rooted AND counted: a wire requirement no receiver checks quietly stops holding.
                this.counters.outOfOrderParent++;
            } else {
                entity.attachTo(this.#rt.entityManager.facade(parent));
            }
        }

        // Refused whole, not half-applied: the count is peer-chosen and the work behind it is real.
        if (snapshot.tags.length > MAX_WIRE_ITEMS) {
            this.counters.oversizedList++;
        } else {
            for (const tag of snapshot.tags) entity.tag(tag);
        }

        const attachments = snapshot.overrides?.scripts ?? [];
        // Before this envelope's state diffs: attaching hoists `@serverState` onto the host record,
        // and the wire's values must land on the hoisted accessors.
        if (attachments.length > MAX_ENTITY_SCRIPTS) {
            this.counters.oversizedList++;
        } else {
            for (const attachment of attachments) this.#attach(local, attachment);
        }
        // `spawn` sets position only: a wall authored at scale 3 renders at scale 1 forever.
        this.#writeTransform(local, t);
        delta.added.push(local);
    }

    /** Attaches one script named by the wire, or counts the miss; a `ServerScript` is skipped. */
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
        this.#rt.wiring?.attachToEntity(local, klass, attachment.props);
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
        // Minted directly: `joinPlayer` dispatches `@onPlayerJoin`, which is the server's job.
        // `index` comes from the wire, so a joiner does not renumber the roster.
        const player = new Player(this.#rt, snapshot.id, snapshot.index, snapshot.name);
        this.#rt.playerManager?.adopt(player);
        this.#rt.hosts.ensure(playerKey(snapshot.id));
        return player;
    }

    /**
     * Writes the host record directly, so a later `ClientScript` hoists onto this same record.
     * Through core's `restoreHostField`: a wrapper field's value is a wrapper, not the payload.
     */
    #applyStateField(diff: StateDiff): void {
        const key = this.#hostKey(diff.host);
        if (key === undefined) return;
        const fields = diff.fields;
        if (typeof fields !== 'object' || fields === null) return;
        const record = this.#rt.hosts.ensure(key).record;
        // Resolved once per diff, not per field, and only when a facade exists to hoist onto.
        const host = this.#facadeFor(diff.host);
        for (const [field, value] of Object.entries(fields)) {
            restoreHostField(record, field, value);
            // Nothing attaches a Game or Player script here, so without this the applied values
            // would be reachable from no creator-facing name at all.
            if (host === undefined) continue;
            if (!hoistReplicated(host, field, record.values)) this.counters.reservedField++;
        }
    }

    /** The object a `ClientScript` names this host by, or undefined for one with no facade here. */
    #facadeFor(host: StateHostAddr): object | undefined {
        switch (host.kind) {
            case 'game':
                return this.#rt.gameInstance ?? undefined;
            case 'player':
                return this.#rt.playerManager?.byId(host.id) ?? undefined;
            case 'entity': {
                const local = this.#index.local(host.netId);
                return local === undefined ? undefined : this.#rt.entityManager.facade(local);
            }
        }
    }

    /** Built with core's helpers: `hosts.ensure` mints a record for any key without validating. */
    #hostKey(host: StateHostAddr): string | undefined {
        switch (host.kind) {
            case 'game':
                return GAME_KEY;
            case 'player':
                return playerKey(host.id);
            case 'entity': {
                const local = this.#resolve(host.netId);
                // The full packed local EntityId, not the slot index.
                return local === undefined ? undefined : entityKey(local);
            }
            default: {
                const unreachable: never = host;
                return unreachable;
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
     * Clears channel marks the client has no consumer for, or the journal grows all session.
     * Safe because `clear()` does not reach the transform dirty set, which lives elsewhere.
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
