// One session: the seams this machine has in, a joinable client out.
//
// It dials nothing and builds no renderer — a `Transport` and an `IRenderer` arrive already made,
// which is what lets a session be driven over a loopback pair with no socket and no GPU at all.
// `GameInstance` is the shape this mirrors: construction composes, `start()` runs, `close()` tears
// down in the one order that does not leak.

import type { ClientHUDSink, FailureReason, SessionState } from '@platform/client';
import type { GameClient } from '@platform/client';
import { createClient } from '@platform/engine/host';
import type { CreateClientOptions } from '@platform/engine/host';

/** What a host supplies that an authored project cannot describe. */
export interface ClientInstanceOptions extends CreateClientOptions {
    /**
     * Every session state change, and the reason when one is a failure.
     *
     * Taken as an option rather than registered afterwards because `start()` may reach `failed`
     * synchronously — a listener attached after it would never hear the only transition there was.
     */
    onState?: (state: SessionState, failure: FailureReason | undefined) => void;
    /**
     * Destroys the renderer with the session. Left false by a host whose renderer outlives the
     * session — a React app whose canvas hook owns it, which is the usual case.
     */
    ownsRenderer?: boolean;
}

/**
 * A composed session, and the two verbs a host drives it with.
 *
 * Construction wires the client and its state listener but sends nothing: `start()` is what joins,
 * so a host may hold a built session it has not committed to. What this owns over `createClient` is
 * the ordering — the listener registered before the join, and a teardown that unsubscribes before
 * it destroys, since `GameClient.destroy` does not clear the lifecycle's own subscribers.
 */
export class ClientInstance {
    readonly client: GameClient;
    readonly #ownsRenderer: boolean;
    #unsubscribe: (() => void) | undefined;
    #closed = false;

    constructor(opts: ClientInstanceOptions) {
        const { onState, ownsRenderer, ...forwarded } = opts;
        this.#ownsRenderer = ownsRenderer ?? false;
        // The composition root rather than `new GameClient`: the identity this session claims is
        // derived from the same manifest the authority booted from, so a peer running other code is
        // refused at the handshake rather than left to diverge.
        this.client = createClient(forwarded);

        if (onState !== undefined) {
            this.#unsubscribe = this.client.lifecycle.onChange((next: SessionState) => {
                onState(next, this.client.lifecycle.failure);
            });
        }
    }

    get state(): SessionState {
        return this.client.state;
    }

    get failure(): FailureReason | undefined {
        return this.client.lifecycle.failure;
    }

    /** The live HUD a host's own interface subscribes to. */
    get hud(): ClientHUDSink {
        return this.client.hud;
    }

    get closed(): boolean {
        return this.#closed;
    }

    /** Sends the join request and starts the frame loop. Idempotent, and inert once closed. */
    start(): this {
        if (!this.#closed) this.client.start();
        return this;
    }

    /**
     * Tears the session down, in the one order that leaves nothing behind. Idempotent.
     *
     * The unsubscribe comes first because `GameClient.destroy` does not clear the lifecycle's
     * listeners, so a host that only destroyed would keep being told about a session it has
     * dropped — and its handler would run against state it has already torn down.
     */
    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#unsubscribe?.();
        this.#unsubscribe = undefined;
        this.client.destroy({ ownsRenderer: this.#ownsRenderer });
    }
}
