// One game instance: a validated project and the seams a host supplies in, a running world out.
//
// It opens no socket and reads no file — a `Transport` arrives from whatever the host is listening
// on, which is what lets a world be driven over a loopback pair with no I/O at all.

import type { BreakerTrip, KVStore } from '@platform/core';
import { createServer } from '@platform/engine/host';
import type { BundleRef } from '@platform/engine/host';
import type { ProjectManifest, ScriptId } from '@platform/project';
import type { ScriptRegistry } from '@platform/scripting';
import type { GameServer } from '@platform/server';
import type { Transport } from '@platform/transport';

export type { BundleRef };

/** What a host supplies that an authored project cannot describe. */
export interface InstanceOptions {
    /** The authored game. `createServer` validates it before anything is built. */
    project: ProjectManifest;
    /** The server chunk's classes, by the id an attachment names. */
    scripts?: ScriptRegistry<ScriptId>;
    /** The code every joiner must be running, and where they fetch it. */
    bundle?: BundleRef;
    /** Where `@serverState` outlives a session. Omitted, it dies with the process. */
    kv?: KVStore;
    /**
     * Wall-clock seconds. Injected so a test can turn the world by hand.
     *
     * The default is the real clock: the world is stepped against elapsed time rather than against
     * the interval's own cadence, so a late timer catches up instead of running the game slow.
     */
    now?: () => number;
    /**
     * Pumps a loopback pair at the top of every step.
     *
     * Omitted networked, where each socket delivers itself. Present for the single-process
     * arrangement — local play, or a test driving both ends on one hand-turned clock.
     */
    deliver?: () => void;
    /** A handler the breaker gave up on. The dev channel, deliberately not an envelope. */
    onBreakerTrip?: (trip: BreakerTrip) => void;
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
    readonly server: GameServer;
    readonly #simRate: number;
    readonly #now: () => number;
    #timer: ReturnType<typeof setInterval> | undefined;
    #closed = false;

    constructor(opts: InstanceOptions) {
        const { project, now, ...forwarded } = opts;
        this.#now = now ?? (() => Date.now() / 1000);
        // Read off the manifest rather than the booted server, because the tick interval has to be
        // known before there is a server to ask.
        this.#simRate = project.settings.simRate;

        this.server = createServer(project, forwarded);
    }

    /** Settles when every Game start handler has finished, for a host that wants to know. */
    get started(): Promise<void> {
        return this.server.started;
    }

    get closed(): boolean {
        return this.#closed;
    }

    /**
     * Starts the tick loop, on an interval that pumps.
     *
     * Never `GameServer.start()`: that drives the Driver directly and skips the join-deadline sweep,
     * so a connection that opens and never joins holds one of the unjoined slots for good.
     */
    start(): this {
        if (this.#closed || this.#timer !== undefined) return this;
        this.#timer = setInterval(() => this.pump(), 1000 / this.#simRate);
        return this;
    }

    /** One wake, for a host that drives its own clock — a test, or a shared scheduler. */
    pump(): void {
        if (this.#closed) return;
        this.server.pump(this.#now());
    }

    /**
     * Admits one established connection under the identity the HOST resolved.
     *
     * The id is never taken from a frame: whatever the host trusts is what the game trusts. It must
     * be a per-game id rather than an account key, because `player.id` reaches every other peer.
     * Answers `null` when the server refused it, having already closed the transport.
     */
    accept(transport: Transport, playerId?: string): string | null {
        if (this.#closed) {
            transport.close();
            return null;
        }
        return this.server.accept(transport, playerId);
    }

    /** Stops the clock and closes every connection. Idempotent. */
    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        if (this.#timer !== undefined) clearInterval(this.#timer);
        this.#timer = undefined;
        this.server.close();
    }
}
