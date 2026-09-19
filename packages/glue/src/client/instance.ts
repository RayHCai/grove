// It dials nothing and builds no renderer — a `Transport` and an `IRenderer` arrive already made,
// which lets a session run over a loopback pair with no socket and no GPU.

import type { ClientHUDSink, FailureReason, SessionState } from '@platform/client';
import type { GameClient } from '@platform/client';
import { createClient } from '@platform/engine/host';
import type { CreateClientOptions } from '@platform/engine/host';

/** What a host supplies that an authored project cannot describe. */
export interface ClientInstanceOptions extends CreateClientOptions {
    /**
     * Every session state change, and the reason when one is a failure.
     * An option rather than a later registration: `start()` may reach `failed` synchronously.
     */
    onState?: (state: SessionState, failure: FailureReason | undefined) => void;
    /**
     * Destroys the renderer with the session. Left false by a host whose renderer outlives the
     * session — a React app whose canvas hook owns it, which is the usual case.
     */
    ownsRenderer?: boolean;
}

/**
 * A composed session, and the two verbs a host drives it with. Construction sends nothing.
 * What it owns over `createClient` is ordering: listener before join, unsubscribe before destroy.
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
     * Unsubscribe first: `GameClient.destroy` does not clear the lifecycle's own listeners.
     */
    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#unsubscribe?.();
        this.#unsubscribe = undefined;
        this.client.destroy({ ownsRenderer: this.#ownsRenderer });
    }
}
