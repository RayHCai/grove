// One peer's failure is that peer's alone: the send loop isolates every connection, and a Welcome
// that never reached the wire leaves its connection still owed one.

import { afterEach, describe, expect, it } from 'vitest';
import { clearRuntime } from '@platform/core';
import { PROTOCOL_VERSION } from '@platform/protocol';
import type { JoinRequest, ServerToClient } from '@platform/protocol';
import type { Message, Transport } from '@platform/transport';
import { Rules } from '../dist/testkit/fixtures.js';
import { harness } from './harness.js';

/**
 * A transport a test can make throw, so the isolation is measured rather than assumed.
 *
 * `close()` records and stops there: a socket's close handler arrives behind its queued frames, so
 * a connection closed inside one send is still in the registry for the next one.
 */
class FlakyTransport implements Transport {
    readonly sent: ServerToClient[] = [];
    failEncoded = false;
    closed = false;
    #onMessage: ((message: Message) => void) | null = null;

    send(message: Message): void {
        this.sent.push(message as unknown as ServerToClient);
    }

    sendEncoded(): void {
        if (this.failEncoded) throw new Error('socket write failed');
    }

    onMessage(handler: (message: Message) => void): () => void {
        this.#onMessage = handler;
        return () => {
            this.#onMessage = null;
        };
    }

    onClose(): () => void {
        return () => {};
    }

    close(): void {
        this.closed = true;
    }

    /** Hands the server one frame, the way a socket's own event loop would. */
    deliver(message: unknown): void {
        this.#onMessage?.(message as Message);
    }

    join(name = 'flaky'): void {
        this.deliver({
            kind: 'join-request',
            protocolVersion: PROTOCOL_VERSION,
            name,
            clientSentMs: 1000,
            projectId: '',
            projectHash: '',
            bundleHash: '',
        } satisfies JoinRequest);
    }
}

afterEach(() => {
    clearRuntime();
});

describe('the fan-out survives one peer', () => {
    it('closes the connection whose send threw and finishes the broadcast', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        // Accepted first, so it is ahead of the healthy peer in the registry — behind it, an
        // unisolated throw would prove nothing.
        const flaky = new FlakyTransport();
        h.server.accept(flaky);
        flaky.join();
        h.pumpTicks(8);
        expect(flaky.sent.some((e) => e.kind === 'state')).toBe(true);

        const good = h.joined('good');
        good.clear();
        flaky.failEncoded = true;
        h.pumpTicks(8);

        expect(flaky.closed).toBe(true);
        expect(good.states.length).toBeGreaterThan(0);
    });

    it('holds the pending join open when the Welcome could not be sent', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const flaky = new FlakyTransport();
        flaky.failEncoded = true;
        h.server.accept(flaky);
        flaky.join();
        h.pumpTicks(12);

        // Answered before the Welcome lands, the connection reads as broadcast-ready and is fed a
        // state envelope whose ops it has no snapshot to apply them against.
        const conn = h.server.connections.find((c) => c.transport === flaky);
        expect(conn?.pendingJoin).not.toBeNull();
        expect(flaky.sent).toStrictEqual([]);
    });
});
