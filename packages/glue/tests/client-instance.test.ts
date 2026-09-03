// What a session owns over `createClient`: the three orderings that fail quietly when a host is
// left to remember them.
//
// No server here. Every case below is about the session's own lifecycle, so the peer end of the
// loopback pair is read directly rather than driven by a world.

import { describe, expect, it } from 'vitest';
import { ManualFrameSource, ScriptedInputDevice } from '@platform/client';
import type { SessionState } from '@platform/client';
import { createReadyNullRenderer } from '@platform/renderer/null';
import type { Message } from '@platform/transport';
import { loopbackPair } from '@platform/transport';
import { ClientInstance, connectTo } from '../src/client/index.js';

interface Built {
    session: ClientInstance;
    /** Everything the peer end has been handed, decoded. */
    received: Message[];
    deliver: () => void;
    seen: SessionState[];
    /** Refuses the join from the peer end — the cheapest real transition to drive. */
    reject(): void;
    /** One client frame, which is where the inbox is drained. */
    frame(): void;
}

async function build(): Promise<Built> {
    const pair = loopbackPair();
    const received: Message[] = [];
    pair.server.onMessage((message) => received.push(message));

    const seen: SessionState[] = [];
    const renderer = await createReadyNullRenderer({ design: { width: 100, height: 100 } });
    const frames = new ManualFrameSource();

    const session = new ClientInstance({
        transport: pair.client,
        renderer,
        frames,
        device: new ScriptedInputDevice(),
        clock: { nowSeconds: () => 0 },
        name: 'tester',
        ownsRenderer: true,
        onState: (state) => seen.push(state),
    });

    let at = 0;
    return {
        session,
        received,
        deliver: () => pair.deliver(),
        seen,
        reject: () =>
            pair.server.send({ kind: 'reject', reason: 'full', serverProtocolVersion: 2 }),
        frame: () => {
            at += 1 / 60;
            frames.frame(at);
        },
    };
}

describe('a client instance', () => {
    it('composes without joining, and joins only on start', async () => {
        const { session, received, deliver } = await build();

        // Construction wires the client and its listener. It sends nothing: a host may hold a
        // built session it has not committed to.
        deliver();
        expect(received).toHaveLength(0);

        session.start();
        deliver();
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({ kind: 'join-request' });

        session.close();
    });

    it('hands a host the transitions of a session it never subscribed to itself', async () => {
        const { session, seen, deliver, reject, frame } = await build();
        // Wired at construction, so it predates every send. Nothing has moved yet.
        expect(seen).toEqual([]);

        session.start();
        deliver();
        reject();
        deliver();
        frame();

        expect(seen).toContain('failed');
        expect(session.state).toBe('failed');
        expect(session.failure).toMatchObject({ kind: 'rejected' });

        session.close();
    });

    it('tells a host nothing more once the session is closed', async () => {
        const { session, seen, deliver, reject, frame } = await build();
        session.start();
        deliver();

        const before = seen.length;
        session.close();

        // `GameClient.destroy` does not clear the lifecycle's subscribers, so the unsubscribe in
        // `close()` is the only thing standing between a dropped session and a host handler that
        // runs against state it has already torn down.
        reject();
        deliver();
        frame();
        expect(seen).toHaveLength(before);
    });

    it('is idempotent to close, and inert to a start after one', async () => {
        const { session, received, deliver } = await build();
        session.close();
        session.close();
        expect(session.closed).toBe(true);

        session.start();
        deliver();
        // A closed session joins nothing: `start()` after `close()` must not resurrect a socket
        // whose session is gone.
        expect(received).toHaveLength(0);
    });

    it('exposes the session state and the hud its host draws from', async () => {
        const { session } = await build();
        expect(session.state).toBe(session.client.state);
        expect(session.hud).toBe(session.client.hud);
        expect(session.failure).toBeUndefined();
        session.close();
    });
});

describe('connectTo', () => {
    it('dials nothing for a host that has already given up', async () => {
        const renderer = await createReadyNullRenderer({ design: { width: 100, height: 100 } });
        const controller = new AbortController();
        controller.abort();

        // Refused before the dial, so an aborted host never opens a socket it would then have to
        // remember to close — which is the failure this signal exists to remove.
        await expect(
            connectTo({
                url: 'ws://127.0.0.1:1/never',
                signal: controller.signal,
                renderer,
                frames: new ManualFrameSource(),
                device: new ScriptedInputDevice(),
                clock: { nowSeconds: () => 0 },
                name: 'tester',
            }),
        ).rejects.toThrow();

        renderer.destroy();
    });
});
