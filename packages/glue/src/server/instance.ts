// One game instance in this process: a validated project and the seams a host supplies in, a running
// world out.
//
// It is the in-process half of what `apps/grove/host` does in Rust — the clock, the sockets and the
// store around `@platform/sim`'s deterministic advance. It opens no listener itself: a `Transport`
// arrives from whatever the caller is listening on, which is what lets a world be driven over a
// loopback pair with no I/O at all.

import type { BreakerTrip, KVStore } from '@platform/core';
import { MemoryKVStore, PERSISTENCE_SCOPE } from '@platform/core';
import { createSim } from '@platform/engine/host';
import type { BundleRef } from '@platform/engine/host';
import type { ProjectManifest, ScriptId } from '@platform/project';
import type { ScriptRegistry } from '@platform/scripting';
import type { ConnectionId, InputBatch, LoadedRecord, OutputBatch, Sim } from '@platform/sim';
import type { Codec, EncodedFrame, JsonValue, Message, Transport } from '@platform/transport';
import { jsonCodec } from '@platform/transport';
import { Driver } from './driver.js';
import type { PumpResult } from './driver.js';

/** What a host supplies that an authored project cannot describe. */
export interface InstanceOptions {
    /** The authored game. `createSim` validates it before anything is built. */
    project: ProjectManifest;
    /** The server chunk's classes, by the id an attachment names. */
    scripts?: ScriptRegistry<ScriptId>;
    /** The code every joiner must be running, and where they fetch it. */
    bundle?: BundleRef;
    /** Where `@serverState` outlives a session. Omitted, a memory store that dies with the process. */
    kv?: KVStore;
    /** The wire codec, uniform across this process's connections. Defaults to transport's JSON one. */
    codec?: Codec;
    /**
     * Wall-clock seconds. Injected so a test can turn the world by hand.
     *
     * The default is the real clock: the world is stepped against elapsed time rather than against
     * the interval's own cadence, so a late timer catches up instead of running the game slow.
     */
    now?: () => number;
    /**
     * Pumps a loopback pair at the top of every wake.
     *
     * Omitted networked, where each socket delivers itself. Present for the single-process
     * arrangement — local play, or a test driving both ends on one hand-turned clock.
     */
    deliver?: () => void;
    /** A handler the breaker gave up on. The dev channel, deliberately not an envelope. */
    onBreakerTrip?: (trip: BreakerTrip) => void;
    /** Where this world's diagnostics go. Without one, an operator has no record of why a session died. */
    onLog?: (line: string) => void;
}

/**
 * A booted world, and the two verbs a host drives it with.
 *
 * Construction runs the whole boot: validate, resolve every attachment's class, build the templates,
 * instantiate the placed world, and run each Game `@onStart` to its first await. Only then will
 * `accept` admit anything — a connection taken earlier is answered with a snapshot of a world still
 * being assembled, and a joiner's baseline is the one thing no later delta repairs.
 */
export class GameInstance {
    readonly sim: Sim;
    readonly #driver: Driver;
    readonly #codec: Codec;
    readonly #kv: KVStore;
    readonly #log: (line: string) => void;
    /** The clock `pump()` reads when the caller names none — injected, so a test turns it by hand. */
    readonly #now: () => number;
    /** The sockets the sim's connection ids name — the half of a session the sim deliberately holds none of. */
    readonly #transports = new Map<ConnectionId, Transport>();
    /** Disposers from each transport's `onMessage` / `onClose`, run once when it goes. */
    readonly #disposers = new Map<ConnectionId, Array<() => void>>();
    /** Store writes still in flight, so a shutdown can wait for the ones it just started. */
    readonly #saves = new Set<Promise<unknown>>();

    /** What the next tick's batch is being filled with, since arrivals land between ticks. */
    #opened: InputBatch['opened'] = [];
    #frames: InputBatch['frames'] = [];
    #closed: ConnectionId[] = [];
    #records: LoadedRecord[] = [];
    #saved: string[] = [];

    #nextConnectionId = 1;
    #shutdown = false;
    #drain: Promise<void> = Promise.resolve();

    constructor(opts: InstanceOptions) {
        const { project, now, deliver, kv, codec, onLog, ...forwarded } = opts;
        this.#codec = codec ?? jsonCodec;
        this.#kv = kv ?? new MemoryKVStore();
        this.#log = onLog ?? ((): void => {});
        this.#now = now ?? ((): number => Date.now() / 1000);

        // The store reaches the world twice over, and deliberately: as the creator's `storage` seam,
        // which a handler awaits, and as the load-and-save protocol this class runs for `@serverState`.
        this.sim = createSim(project, {
            ...forwarded,
            kv: this.#kv,
            log: { warn: this.#log, error: () => {} },
        });

        // Read off the manifest rather than the booted sim, because the interval has to be known
        // before there is a world to ask.
        this.#driver = new Driver(
            { stepOnce: (drain) => this.#step(drain) },
            {
                simRate: project.settings.simRate,
                sendRate: this.sim.config.sendRate,
                ...(deliver === undefined ? {} : { deliver }),
                ...(now === undefined ? {} : { now }),
            },
        );
    }

    /** Settles when every Game start handler has finished, for a host that wants to know. */
    get started(): Promise<void> {
        return this.sim.started;
    }

    get closed(): boolean {
        return this.#shutdown;
    }

    /** How many wakes hit the step cap with backlog left and shed it — the sim falling behind. */
    get shedCount(): number {
        return this.#driver.shedCount;
    }

    /**
     * Starts the tick loop, on an interval that pumps.
     *
     * The interval is this class's rather than the driver's own `start`, so every wake also runs the
     * batch loop that answers the sim's loads and saves.
     */
    start(): this {
        if (this.#shutdown || this.#timer !== undefined) return this;
        this.#timer = setInterval(() => this.pump(), 1000 / this.sim.config.simRate);
        return this;
    }

    /** One wake, for a host that drives its own clock — a test, or a shared scheduler. */
    pump(nowSeconds?: number): PumpResult {
        if (this.#shutdown) return { steps: 0, sends: 0, shed: false };
        return this.#driver.pump(nowSeconds ?? this.#now());
    }

    /**
     * Offers one established connection to the world, under the identity the HOST resolved.
     *
     * The id is never taken from a frame: whatever the host trusts is what the game trusts. It must
     * be a per-game id rather than an account key, because `player.id` reaches every other peer.
     *
     * The id it returns names a socket this class now holds; it is NOT an admission. The sim sees the
     * connection at the top of the next tick and may refuse it there — at the unjoined cap, or under
     * an identity another unjoined session already holds — and answers with a close this class acts
     * on. `null` means only that this instance is already shut down.
     */
    accept(transport: Transport, playerId?: string): ConnectionId | null {
        if (this.#shutdown) {
            transport.close();
            return null;
        }
        if (playerId === '') {
            throw new TypeError('playerId must be a non-empty string, or omitted');
        }
        const connectionId = `c${this.#nextConnectionId++}`;
        this.#transports.set(connectionId, transport);
        // Registered before the sim is told, because `ws` resumes the stream on the next tick and a
        // frame arriving before this listener exists is simply gone.
        this.#disposers.set(connectionId, [
            transport.onMessage((message) => this.#frames.push({ connectionId, message })),
            transport.onClose(() => this.#closed.push(connectionId)),
        ]);
        this.#opened.push({ connectionId, identity: playerId ?? null });
        return connectionId;
    }

    /** Declares visuals for templates that have come into use since boot. Idempotent per name. */
    declareVisuals(...args: Parameters<Sim['declareVisuals']>): void {
        this.sim.declareVisuals(...args);
    }

    /**
     * Changes the timestep mid-session, on the world AND on the clock that drives it.
     *
     * Both, always: the sim retunes core and tells every client, and the driver holds the cadence —
     * so a rate changed on one alone runs the world at a speed nothing agrees on.
     */
    setSimRate(simRate: number): void {
        this.sim.setSimRate(simRate);
        this.#driver.setRates(simRate, this.sim.config.sendRate);
        if (this.#timer === undefined) return;
        // The interval is the tick length, so it is restarted rather than left at the old one.
        clearInterval(this.#timer);
        this.#timer = setInterval(() => this.pump(), 1000 / simRate);
    }

    /**
     * Stops the clock, releases every session and settles once every departing player's save has
     * landed.
     *
     * `allSettled` rather than `all`, since a store that rejects must release the drain rather than
     * hold the shutdown open on the one write that will never land. Idempotent.
     */
    close(): Promise<void> {
        if (this.#shutdown) return this.#drain;
        this.#shutdown = true;
        if (this.#timer !== undefined) clearInterval(this.#timer);
        this.#timer = undefined;
        this.#apply(this.sim.close());
        for (const transport of this.#transports.values()) transport.close();
        this.#forgetAll();
        this.#drain = Promise.allSettled(this.#saves).then(() => undefined);
        return this.#drain;
    }

    #timer: ReturnType<typeof setInterval> | undefined;

    /** One tick: hand the sim everything that arrived, then act on everything it asks for. */
    #step(drain: boolean): void {
        const batch: InputBatch = {
            nowMs: this.#driver.nowSeconds * 1000,
            drain,
            opened: this.#opened,
            frames: this.#frames,
            closed: this.#closed,
            records: this.#records,
            saved: this.#saved,
        };
        this.#opened = [];
        this.#frames = [];
        this.#closed = [];
        this.#records = [];
        this.#saved = [];
        this.#apply(this.sim.tick(batch));
    }

    /** Everything one output batch orders, in the order it must happen: write, then close, then store. */
    #apply(out: OutputBatch): void {
        for (const line of out.log) this.#log(line.line);

        for (const send of out.sends) {
            // Encoded once for a shared envelope, which is the whole point of `to` being a list:
            // most of a state envelope is per-connection, so the transform frame is the only
            // subset N peers can share.
            let encoded: EncodedFrame | null = null;
            for (const connectionId of send.to) {
                const transport = this.#transports.get(connectionId);
                if (transport === undefined) continue;
                try {
                    if (send.to.length === 1) {
                        transport.send(send.envelope as unknown as Message);
                        continue;
                    }
                    encoded ??= this.#codec.encode(send.envelope as unknown as Message);
                    transport.sendEncoded(encoded);
                } catch (cause) {
                    // Per connection: without it one peer whose encode throws takes the broadcast
                    // down for every peer behind it.
                    this.#log(`close conn=${connectionId} reason=send-failed: ${reason(cause)}`);
                    this.#closeConnection(connectionId);
                }
            }
        }

        // After the sends, so a `Reject` reaches the wire before the close that follows it.
        for (const order of out.closes) this.#closeConnection(order.connectionId);

        for (const load of out.loads) this.#load(load.connectionId, load.hostKey);
        for (const save of out.saves) this.#save(save.hostKey, save.fields);
    }

    /** Reads a player's record and hands it back on a later tick, which is the whole of the load protocol. */
    #load(connectionId: ConnectionId, hostKey: string): void {
        void this.#kv
            .get(PERSISTENCE_SCOPE, hostKey)
            .then((stored) => {
                // `{}` for a store that held nothing — and for one holding a value no reader could
                // use, which is the same answer core's own cache gave it — so the leave still writes
                // what this session produced. `null` is reserved for the read below that FAILED.
                this.#records.push({ connectionId, fields: asFields(stored) ?? {} });
            })
            // Answered with nothing rather than left unanswered: a store that cannot be read is a
            // degraded session, and a join that never resumes is a hung socket.
            .catch((cause: unknown) => {
                this.#log(`reading ${hostKey} failed: ${reason(cause)}`);
                this.#records.push({ connectionId, fields: null });
            });
    }

    /** Writes a departing player's record through, and tells the sim once it has landed. */
    #save(hostKey: string, fields: { [field: string]: JsonValue }): void {
        const write = this.#kv.set(PERSISTENCE_SCOPE, hostKey, fields).then(
            () => {
                this.#saved.push(hostKey);
            },
            (cause: unknown) => {
                // Not acknowledged: the sim holds the record so a rejoin still reads this session's
                // values back, which is the better of the two wrong answers.
                this.#log(`persisting ${hostKey} failed: ${reason(cause)}`);
            },
        );
        this.#saves.add(write);
        // Dropped once it settles, so a long session is not sized by every player it ever saw.
        void write.finally(() => this.#saves.delete(write));
    }

    /**
     * Closes one socket and tells the sim it is gone.
     *
     * Reported here rather than left to `transport.onClose`, because the disposers below unregister
     * that handler: without this line the sim keeps the session, its `Player` is never released, and
     * every later broadcast is built for a peer nothing is listening on.
     */
    #closeConnection(connectionId: ConnectionId): void {
        const transport = this.#transports.get(connectionId);
        if (transport === undefined) return;
        this.#transports.delete(connectionId);
        for (const dispose of this.#disposers.get(connectionId) ?? []) dispose();
        this.#disposers.delete(connectionId);
        this.#closed.push(connectionId);
        transport.close();
    }

    #forgetAll(): void {
        for (const disposers of this.#disposers.values())
            for (const dispose of disposers) dispose();
        this.#disposers.clear();
        this.#transports.clear();
    }
}

/** Anything but a plain object is another writer's value or a corrupted one, and reads as no record. */
function asFields(stored: unknown): { [field: string]: JsonValue } | null {
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return null;
    return stored as { [field: string]: JsonValue };
}

/** The message of an unknown throwable, since a `catch` binding is not an `Error`. */
function reason(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}
