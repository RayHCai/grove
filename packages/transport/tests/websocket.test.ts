import { describe, it, expect, vi } from 'vitest';
import type { Codec } from '../src/codec.js';
import { jsonCodec } from '../src/codec.js';
import { TransportError } from '../src/errors.js';
import type {
    Connect,
    EncodedFrame,
    Frame,
    Message,
    TimerSource,
    Transport,
} from '../src/transport.js';
import type { WebSocketLike, WebSocketOptions } from '../src/websocket.js';
import { connectWebSocket, webSocketTransport } from '../src/websocket.js';

/** `readyState` values, as the standard fixes them. */
const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** Mirrors the backend's own constants, so a change to either breaks this file. */
const HEARTBEAT_INTERVAL_MS = 5000;
const MAX_MISSED_HEARTBEATS = 3;

/**
 * A socket whose events the test drives.
 *
 * `close()` only moves to CLOSING, exactly as a real socket does — the close EVENT is a separate,
 * later task, and every ordering guarantee below depends on that being modelled honestly.
 */
class FakeSocket implements WebSocketLike {
    readyState: number;
    bufferedAmount = 0;
    binaryType?: unknown;
    readonly sent: Frame[] = [];
    readonly closeCodes: Array<number | undefined> = [];
    readonly #listeners = new Map<string, Array<(event: unknown) => void>>();

    constructor(readyState = OPEN) {
        this.readyState = readyState;
    }

    send(data: string | Uint8Array<ArrayBuffer>): void {
        this.sent.push(data);
    }

    close(code?: number): void {
        this.closeCodes.push(code);
        if (this.readyState === OPEN || this.readyState === CONNECTING) this.readyState = CLOSING;
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
        const existing = this.#listeners.get(type);
        if (existing === undefined) this.#listeners.set(type, [listener]);
        else existing.push(listener);
    }

    get listenerCount(): number {
        let total = 0;
        for (const listeners of this.#listeners.values()) total += listeners.length;
        return total;
    }

    emitOpen(): void {
        this.readyState = OPEN;
        this.#emit('open', {});
    }

    emitMessage(data: unknown): void {
        this.#emit('message', { data });
    }

    emitError(): void {
        this.#emit('error', {});
    }

    emitClose(code: number | undefined = 1000): void {
        this.readyState = CLOSED;
        this.#emit('close', code === undefined ? {} : { code });
    }

    #emit(type: string, event: unknown): void {
        // Copied, so a listener registering during dispatch cannot alter the dispatch it is inside.
        for (const listener of Array.from(this.#listeners.get(type) ?? [])) listener(event);
    }
}

class FakeTimer implements TimerSource {
    #next = 1;
    readonly live = new Map<number, { fn: () => void; ms: number }>();

    setInterval(fn: () => void, ms: number): unknown {
        const handle = this.#next++;
        this.live.set(handle, { fn, ms });
        return handle;
    }

    clearInterval(handle: unknown): void {
        this.live.delete(handle as number);
    }

    /** Fires every live interval `times` times, snapshotting so a callback may clear its own. */
    advance(times = 1): void {
        for (let i = 0; i < times; i++) {
            for (const entry of Array.from(this.live.values())) entry.fn();
        }
    }
}

/** A codec whose frames are bytes, for the binary inbound path `jsonCodec` cannot exercise. */
const byteCodec: Codec = {
    encode: (message) => new TextEncoder().encode(JSON.stringify(message)) as EncodedFrame,
    decode: (frame) =>
        JSON.parse(typeof frame === 'string' ? frame : new TextDecoder().decode(frame)) as Message,
    byteLength: (frame) => (typeof frame === 'string' ? frame.length : frame.byteLength),
};

interface Harness {
    socket: FakeSocket;
    timer: FakeTimer;
    /** Everything reported through `onError`, in order. */
    errors: TransportError[];
    transport: Transport;
}

function harness(opts: WebSocketOptions & { socket?: FakeSocket } = {}): Harness {
    const { socket = new FakeSocket(), ...rest } = opts;
    const timer = new FakeTimer();
    const errors: TransportError[] = [];
    const transport = webSocketTransport(socket, {
        timer,
        onError: (error) => errors.push(error),
        ...rest,
    });
    return { socket, timer, errors, transport };
}

/** Collects everything an end receives, in delivery order. */
function collect(end: Transport): Message[] {
    const seen: Message[] = [];
    end.onMessage((m) => seen.push(m));
    return seen;
}

function codes(errors: readonly TransportError[]): string[] {
    return errors.map((error) => error.code);
}

describe('connectWebSocket — a Transport is only handed out once connected', () => {
    it('is the declared Connect seam', () => {
        // Both endpoints compile against `Connect`, so a signature drift is a type error on this
        // line rather than a broken composition root.
        const dial: Connect = connectWebSocket;
        expect(dial).toBe(connectWebSocket);
    });

    it('does not resolve until the socket is OPEN', async () => {
        const socket = new FakeSocket(CONNECTING);
        const settled = vi.fn();
        const pending = connectWebSocket('ws://host/game', { createSocket: () => socket }).then(
            settled,
        );

        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();

        socket.emitOpen();
        await pending;
        expect(settled).toHaveBeenCalledOnce();
    });

    it('resolves with a live Transport', async () => {
        const socket = new FakeSocket(CONNECTING);
        const connecting = connectWebSocket('ws://host/game', { createSocket: () => socket });
        socket.emitOpen();

        const transport = await connecting;
        transport.send({ kind: 'join-request' });
        expect(socket.sent).toEqual([JSON.stringify({ kind: 'join-request' })]);
    });

    it('passes the url to the socket factory verbatim', async () => {
        const socket = new FakeSocket(CONNECTING);
        const createSocket = vi.fn(() => socket);
        const connecting = connectWebSocket('wss://host:8443/game?x=1', { createSocket });
        socket.emitOpen();
        await connecting;

        expect(createSocket).toHaveBeenCalledWith('wss://host:8443/game?x=1');
    });

    it('refuses connect-failed when the socket errors before opening', async () => {
        const socket = new FakeSocket(CONNECTING);
        const connecting = connectWebSocket('ws://host/game', { createSocket: () => socket });
        socket.emitError();

        await expect(connecting).rejects.toThrow(TransportError);
        await expect(connecting).rejects.toMatchObject({ code: 'connect-failed' });
    });

    it('refuses connect-failed when the socket closes before opening', async () => {
        // A refused TCP connection and a rejecting proxy both look like this, and neither leaves a
        // Transport anyone could hold.
        const socket = new FakeSocket(CONNECTING);
        const connecting = connectWebSocket('ws://host/game', { createSocket: () => socket });
        socket.emitClose(1006);

        await expect(connecting).rejects.toMatchObject({ code: 'connect-failed' });
        await expect(connecting).rejects.toThrow(/1006/);
    });

    it('refuses connect-failed when the socket constructor throws', async () => {
        // A malformed url, and a runtime with no global WebSocket, both land here.
        const connecting = connectWebSocket('nonsense', {
            createSocket: () => {
                throw new Error('SyntaxError: bad url');
            },
        });

        await expect(connecting).rejects.toMatchObject({ code: 'connect-failed' });
        await expect(connecting).rejects.toThrow(/bad url/);
    });

    it('chains the constructor failure as the cause', async () => {
        const cause = new Error('no global WebSocket');
        const connecting = connectWebSocket('ws://host/game', {
            createSocket: () => {
                throw cause;
            },
        });

        await expect(connecting).rejects.toMatchObject({ cause });
    });

    it('settles once, so a later socket failure cannot re-refuse a resolved promise', async () => {
        const socket = new FakeSocket(CONNECTING);
        const connecting = connectWebSocket('ws://host/game', { createSocket: () => socket });
        socket.emitOpen();
        const transport = await connecting;

        // The dial's own listeners outlive the settle, so these have to be no-ops rather than a
        // second reporting path.
        socket.emitError();
        socket.emitClose(1006);
        await expect(connecting).resolves.toBe(transport);
    });

    it('validates its options before it opens anything', () => {
        const createSocket = vi.fn(() => new FakeSocket(CONNECTING));
        expect(() =>
            connectWebSocket('ws://host/game', { createSocket, maxRetainedBytes: 0 }),
        ).toThrow(expect.objectContaining({ code: 'invalid-option' }));
        // Nothing was constructed, so nothing has to be torn down.
        expect(createSocket).not.toHaveBeenCalled();
    });
});

describe('webSocketTransport — the accept door', () => {
    it('takes a socket a listener already opened', () => {
        const { socket, transport } = harness();
        transport.send({ kind: 'welcome' });
        expect(socket.sent).toEqual([JSON.stringify({ kind: 'welcome' })]);
    });

    it('refuses a socket that is still connecting', () => {
        // Holding a Transport means connected; a connecting socket is the dial's business.
        expect(() => webSocketTransport(new FakeSocket(CONNECTING))).toThrow(
            expect.objectContaining({ code: 'invalid-option' }),
        );
    });

    it('refuses a socket that has already closed', () => {
        expect(() => webSocketTransport(new FakeSocket(CLOSED))).toThrow(
            expect.objectContaining({ code: 'invalid-option' }),
        );
    });

    it('refuses a socket that is closing', () => {
        expect(() => webSocketTransport(new FakeSocket(CLOSING))).toThrow(
            expect.objectContaining({ code: 'invalid-option' }),
        );
    });

    it('asks for arraybuffer frames, so no frame ever arrives as a Blob', () => {
        // A Blob would have to be awaited, and awaiting reorders frames.
        const { socket } = harness();
        expect(socket.binaryType).toBe('arraybuffer');
    });

    it('refuses a maxBufferedBytes it cannot honour', () => {
        expect(() => harness({ maxBufferedBytes: 0 })).toThrow(
            expect.objectContaining({ code: 'invalid-option' }),
        );
    });

    it('refuses a maxRetainedBytes it cannot honour', () => {
        expect(() => harness({ maxRetainedBytes: -1 })).toThrow(
            expect.objectContaining({ code: 'invalid-option' }),
        );
    });
});

describe('websocket — frames out', () => {
    it('encodes through the injected codec', () => {
        const { socket, transport } = harness({ codec: byteCodec });
        transport.send({ kind: 'input', seq: 3 });
        expect(socket.sent).toEqual([new TextEncoder().encode('{"kind":"input","seq":3}')]);
    });

    it('sends an already-encoded frame without re-encoding it', () => {
        const encode = vi.fn(jsonCodec.encode);
        const { socket, transport } = harness({ codec: { ...jsonCodec, encode } });

        transport.sendEncoded(jsonCodec.encode({ kind: 'transform' }));
        expect(encode).not.toHaveBeenCalled();
        expect(socket.sent).toEqual([JSON.stringify({ kind: 'transform' })]);
    });

    it('rejects an inadmissible payload rather than putting it on the wire', () => {
        const { socket, transport } = harness();
        expect(() => transport.send({ t: Number.NaN })).toThrow(
            expect.objectContaining({ code: 'encode-rejected' }),
        );
        expect(socket.sent).toEqual([]);
    });

    it('encodes BEFORE the closed check, so a bad payload is a bug either way', () => {
        // Otherwise whether a defect throws depends on which peer happened to drop first.
        const { socket, transport } = harness();
        transport.close();
        socket.emitClose();

        expect(() => transport.send({ t: Number.NaN })).toThrow(
            expect.objectContaining({ code: 'encode-rejected' }),
        );
    });
});

describe('websocket — frames in, delivered on arrival', () => {
    it('decodes a string frame to its message', () => {
        const { socket, transport } = harness();
        const seen = collect(transport);

        socket.emitMessage(JSON.stringify({ kind: 'state', tick: 7 }));
        expect(seen).toEqual([{ kind: 'state', tick: 7 }]);
    });

    it('reads an ArrayBuffer frame as bytes', () => {
        const { socket, transport } = harness({ codec: byteCodec });
        const seen = collect(transport);

        socket.emitMessage(new TextEncoder().encode('{"kind":"state"}').buffer);
        expect(seen).toEqual([{ kind: 'state' }]);
    });

    it('reads a Node Buffer frame as bytes, since it is a Uint8Array', () => {
        const { socket, transport } = harness({ codec: byteCodec });
        const seen = collect(transport);

        socket.emitMessage(Buffer.from('{"kind":"state"}'));
        expect(seen).toEqual([{ kind: 'state' }]);
    });

    it('holds strict FIFO order', () => {
        // Order is meaning for the structural channel: destroy-then-spawn and spawn-then-destroy
        // leave different worlds.
        const { socket, transport } = harness();
        const seen = collect(transport);

        for (const tick of [1, 2, 3, 4]) socket.emitMessage(JSON.stringify({ tick }));
        expect(seen).toEqual([{ tick: 1 }, { tick: 2 }, { tick: 3 }, { tick: 4 }]);
    });

    it('needs no pump, because the event loop is the pump', () => {
        const { socket, transport } = harness();
        const seen = collect(transport);
        socket.emitMessage('null');
        expect(seen).toEqual([null]);
    });

    it('closes on a message that is neither a string nor bytes', () => {
        const { socket, transport, errors } = harness();
        collect(transport);

        socket.emitMessage({ live: 'object' });
        expect(codes(errors)).toEqual(['malformed-frame']);
        expect(socket.closeCodes).toEqual([1000]);
    });
});

describe('websocket — a hostile peer closes the connection rather than crashing the process', () => {
    it('reports a decode rejection under its own code and closes', () => {
        const { socket, transport, errors } = harness();
        const seen = collect(transport);

        socket.emitMessage('{"__proto__":{"admin":true}}');
        expect(codes(errors)).toEqual(['pollution-key']);
        expect(seen).toEqual([]);
        expect(socket.closeCodes).toEqual([1000]);
    });

    it('reports unparseable JSON as malformed-frame', () => {
        const { socket, transport, errors } = harness();
        collect(transport);
        socket.emitMessage('{"truncated"');
        expect(codes(errors)).toEqual(['malformed-frame']);
    });

    it('does not throw into the socket event, which nothing could catch', () => {
        const { socket, transport } = harness();
        collect(transport);
        expect(() => socket.emitMessage('{"__proto__":{}}')).not.toThrow();
    });

    it('stops delivering the frames behind a rejected one', () => {
        // The connection is over, so anything queued behind the bad frame is owed to nobody.
        const { socket, transport } = harness();
        const seen = collect(transport);

        socket.emitMessage('{"a":1}');
        socket.emitMessage('{"constructor":{}}');
        socket.emitMessage('{"b":2}');

        expect(seen).toEqual([{ a: 1 }]);
    });

    it('propagates a codec failure that is not a TransportError, since that one is ours', () => {
        const codec: Codec = {
            ...jsonCodec,
            decode: () => {
                throw new RangeError('codec defect');
            },
        };
        const { socket, transport } = harness({ codec });
        collect(transport);

        expect(() => socket.emitMessage('{}')).toThrow(RangeError);
    });

    it('closes with no onError registered too, losing the reason but not the connection', () => {
        const socket = new FakeSocket();
        const transport = webSocketTransport(socket, { timer: new FakeTimer() });
        collect(transport);

        socket.emitMessage('{"prototype":{}}');
        expect(socket.closeCodes).toEqual([1000]);
    });

    it('lets a handler throw, because that one is above the transport', () => {
        const { socket, transport } = harness();
        transport.onMessage(() => {
            throw new Error('boom');
        });
        expect(() => socket.emitMessage('{}')).toThrow('boom');
    });
});

describe('websocket — retention, because registration races arrival', () => {
    it('retains frames that arrive before onMessage and flushes them in order', () => {
        const { socket, transport } = harness();
        socket.emitMessage('{"tick":1}');
        socket.emitMessage('{"tick":2}');

        expect(collect(transport)).toEqual([{ tick: 1 }, { tick: 2 }]);
    });

    it('resumes retaining after a disposer runs', () => {
        const { socket, transport } = harness();
        const first: Message[] = [];
        const dispose = transport.onMessage((m) => first.push(m));

        socket.emitMessage('{"tick":1}');
        dispose();
        socket.emitMessage('{"tick":2}');

        expect(first).toEqual([{ tick: 1 }]);
        expect(collect(transport)).toEqual([{ tick: 2 }]);
    });

    it('reports retention-overflow once, and keeps the connection', () => {
        // The wiring bug is above the transport, and killing a live socket would not fix it.
        const { socket, errors } = harness({ maxRetainedBytes: 16 });

        socket.emitMessage(`"${'x'.repeat(32)}"`);
        socket.emitMessage(`"${'y'.repeat(32)}"`);

        expect(codes(errors)).toEqual(['retention-overflow']);
        expect(socket.closeCodes).toEqual([]);
    });

    it('drops the overflowing frame rather than queueing it', () => {
        const { socket, transport } = harness({ maxRetainedBytes: 16 });
        socket.emitMessage('"kept"');
        socket.emitMessage(`"${'x'.repeat(64)}"`);

        expect(collect(transport)).toEqual(['kept']);
    });

    it('stops enforcing the cap once a handler is registered', () => {
        // A backlog behind a live handler drains on arrival; one behind no handler never can.
        const { socket, transport, errors } = harness({ maxRetainedBytes: 16 });
        const seen = collect(transport);

        for (let i = 0; i < 50; i++) socket.emitMessage(`"${'x'.repeat(32)}"`);

        expect(seen).toHaveLength(50);
        expect(errors).toEqual([]);
    });
});

describe('websocket — one handler per end', () => {
    it('refuses a second live onMessage', () => {
        // Two consumers would silently split one connection's frames.
        const { transport } = harness();
        transport.onMessage(() => {});
        expect(() => transport.onMessage(() => {})).toThrow(
            expect.objectContaining({ code: 'handler-already-registered' }),
        );
    });

    it('refuses a second live onClose', () => {
        const { transport } = harness();
        transport.onClose(() => {});
        expect(() => transport.onClose(() => {})).toThrow(
            expect.objectContaining({ code: 'handler-already-registered' }),
        );
    });

    it('allows a replacement after the disposer runs', () => {
        const { transport } = harness();
        transport.onMessage(() => {})();
        expect(() => transport.onMessage(() => {})).not.toThrow();
    });

    it('ignores a stale disposer, so it cannot unregister its successor', () => {
        const { socket, transport } = harness();
        const stale = transport.onMessage(() => {});
        stale();
        const seen = collect(transport);
        stale();

        socket.emitMessage('{"tick":1}');
        expect(seen).toEqual([{ tick: 1 }]);
    });
});

describe('websocket — close rides the FIFO', () => {
    it('never fires onClose inside close(), because the socket reports it as a later task', () => {
        const { socket, transport } = harness();
        const closed = vi.fn();
        transport.onClose(closed);

        transport.close();
        expect(closed).not.toHaveBeenCalled();

        socket.emitClose();
        expect(closed).toHaveBeenCalledOnce();
    });

    it('is idempotent', () => {
        const { socket, transport } = harness();
        transport.close();
        transport.close();
        transport.close();
        expect(socket.closeCodes).toEqual([1000]);
    });

    it('closes with 1000, because a close code is not a protocol channel', () => {
        const { socket, transport } = harness();
        transport.close();
        expect(socket.closeCodes).toEqual([1000]);
    });

    it('fires onClose after every frame ahead of it, whatever order the handlers registered in', () => {
        // onClose first is the hostile order: the marker is eligible before the frames have a taker.
        const { socket, transport } = harness();
        const order: string[] = [];
        transport.onClose(() => order.push('close'));

        socket.emitMessage('{"tick":1}');
        socket.emitClose();
        expect(order).toEqual([]);

        transport.onMessage((m) => order.push(`message ${JSON.stringify(m)}`));
        expect(order).toEqual(['message {"tick":1}', 'close']);
    });

    it('fires onClose exactly once even if the socket reports its close twice', () => {
        const { socket, transport } = harness();
        const closed = vi.fn();
        transport.onClose(closed);

        socket.emitClose();
        socket.emitClose();
        expect(closed).toHaveBeenCalledOnce();
    });

    it('fires onClose on a registration that comes after the socket died', () => {
        const { socket, transport } = harness();
        socket.emitClose();

        const closed = vi.fn();
        transport.onClose(closed);
        expect(closed).toHaveBeenCalledOnce();
    });

    it('delivers what the peer sent before its close, then the close', () => {
        const { socket, transport } = harness();
        const seen = collect(transport);
        const closed = vi.fn();
        transport.onClose(closed);

        socket.emitMessage('{"tick":1}');
        socket.emitClose();

        expect(seen).toEqual([{ tick: 1 }]);
        expect(closed).toHaveBeenCalledOnce();
    });

    it('makes send a silent no-op after close, so one dead peer cannot abort a fan-out', () => {
        const { socket, transport } = harness();
        socket.emitClose();

        expect(() => transport.send({ kind: 'state' })).not.toThrow();
        expect(() => transport.sendEncoded(jsonCodec.encode({ kind: 'state' }))).not.toThrow();
        expect(socket.sent).toEqual([]);
    });

    it('makes send a no-op while the socket is merely CLOSING', () => {
        // The close event has not arrived, so nothing here knows yet — but the socket would throw.
        const { socket, transport } = harness();
        socket.close();
        transport.send({ kind: 'state' });
        expect(socket.sent).toEqual([]);
    });

    it('drops a peer frame arriving into a sealed inbox', () => {
        // It would otherwise queue into something nothing will ever drain.
        const { socket, transport } = harness();
        const seen = collect(transport);
        transport.close();

        socket.emitMessage('{"tick":1}');
        expect(seen).toEqual([]);
    });
});

describe('websocket — a close nobody asked for is not a clean close', () => {
    it('reports socket-error for an abnormal close code', () => {
        // 1006 is a link that dropped without a close frame, and onClose alone cannot show it.
        const { socket, errors } = harness();
        socket.emitClose(1006);
        expect(codes(errors)).toEqual(['socket-error']);
        expect(errors[0]?.message).toMatch(/1006/);
    });

    it('stays quiet for 1000', () => {
        const { socket, errors } = harness();
        socket.emitClose(1000);
        expect(errors).toEqual([]);
    });

    it('stays quiet for 1001, which is a tab navigating away', () => {
        // Reporting it would make every page close look hostile.
        const { socket, errors } = harness();
        socket.emitClose(1001);
        expect(errors).toEqual([]);
    });

    it('stays quiet when the close event carries no code at all', () => {
        const { socket, errors } = harness();
        socket.emitClose(undefined);
        expect(errors).toEqual([]);
    });

    it("does not blame the peer for this end's own teardown", () => {
        // An implementation may still report 1006 after a local close.
        const { socket, transport, errors } = harness();
        transport.close();
        socket.emitClose(1006);
        expect(errors).toEqual([]);
    });

    it('reports socket-error on an error event, and still closes through the close that follows', () => {
        const { socket, transport, errors } = harness();
        const closed = vi.fn();
        transport.onClose(closed);

        socket.emitError();
        expect(codes(errors)).toEqual(['socket-error']);

        socket.emitClose(1006);
        expect(closed).toHaveBeenCalledOnce();
    });

    it('ignores an error event after this end already closed', () => {
        const { socket, transport, errors } = harness();
        transport.close();
        socket.emitClose();
        socket.emitError();
        expect(errors).toEqual([]);
    });
});

describe('websocket — the heartbeat is a silence cutoff, and sends nothing', () => {
    it('closes once the missed windows run out', () => {
        const { socket, timer, errors } = harness();
        timer.advance(MAX_MISSED_HEARTBEATS - 1);
        expect(socket.closeCodes).toEqual([]);

        timer.advance();
        expect(codes(errors)).toEqual(['heartbeat-timeout']);
        expect(socket.closeCodes).toEqual([1000]);
    });

    it('puts no bytes on the wire, because the wire has no ping to send', () => {
        // Protocol's messages are the whole wire, and a browser cannot send a ping frame.
        const { socket, timer } = harness();
        timer.advance(MAX_MISSED_HEARTBEATS);
        expect(socket.sent).toEqual([]);
    });

    it('counts windows, so any inbound frame resets it', () => {
        const { socket, timer, transport } = harness();
        collect(transport);

        // Ten rounds of near-death: a client sending a time-sync every 2 s never trips this.
        for (let round = 0; round < 10; round++) {
            timer.advance(MAX_MISSED_HEARTBEATS - 1);
            socket.emitMessage('{"kind":"time-sync"}');
        }
        timer.advance(MAX_MISSED_HEARTBEATS - 1);

        expect(socket.closeCodes).toEqual([]);
    });

    it('counts a frame it refuses as proof of life too', () => {
        const { socket, timer, errors } = harness({ maxRetainedBytes: 4 });
        timer.advance(MAX_MISSED_HEARTBEATS - 1);
        socket.emitMessage(`"${'x'.repeat(64)}"`);
        timer.advance(MAX_MISSED_HEARTBEATS - 1);

        expect(codes(errors)).toEqual(['retention-overflow']);
        expect(socket.closeCodes).toEqual([]);
    });

    it('runs on the injected interval', () => {
        const { timer } = harness();
        expect([...timer.live.values()].map((entry) => entry.ms)).toEqual([HEARTBEAT_INTERVAL_MS]);
    });

    it('clears its interval on a local close, so the closure stops holding this end', () => {
        const { transport, timer } = harness();
        transport.close();
        expect(timer.live.size).toBe(0);
    });

    it('clears its interval when the socket dies on its own', () => {
        const { socket, timer } = harness();
        socket.emitClose(1006);
        expect(timer.live.size).toBe(0);
    });

    it('falls back to a real timer when none is injected', () => {
        const socket = new FakeSocket();
        const transport = webSocketTransport(socket);
        // Closed immediately, so the real interval it just armed does not outlive this test.
        expect(() => transport.close()).not.toThrow();
    });
});

describe('websocket — a peer that stops draining is closed, not buffered for', () => {
    it('sends while the socket buffer is at the cap', () => {
        const { socket, transport } = harness({ maxBufferedBytes: 1024 });
        socket.bufferedAmount = 1024;
        transport.send({ kind: 'state' });
        expect(socket.sent).toHaveLength(1);
    });

    it('closes once the socket buffer passes the cap', () => {
        const { socket, transport, errors } = harness({ maxBufferedBytes: 1024 });
        socket.bufferedAmount = 1025;
        transport.send({ kind: 'state' });

        expect(socket.sent).toEqual([]);
        expect(codes(errors)).toEqual(['send-buffer-overflow']);
        expect(socket.closeCodes).toEqual([1000]);
    });

    it('bounds sendEncoded on the same cap, since a fan-out is where a backlog builds', () => {
        const { socket, transport, errors } = harness({ maxBufferedBytes: 8 });
        socket.bufferedAmount = 64;
        transport.sendEncoded(jsonCodec.encode({ kind: 'transform' }));

        expect(socket.sent).toEqual([]);
        expect(codes(errors)).toEqual(['send-buffer-overflow']);
    });

    it('reports the overflow once, since the connection is over after it', () => {
        const { socket, transport, errors } = harness({ maxBufferedBytes: 8 });
        socket.bufferedAmount = 64;
        transport.send({ kind: 'state' });
        transport.send({ kind: 'state' });

        expect(errors).toHaveLength(1);
    });
});

describe('websocket — the socket stays the composition root and no listener is displaced', () => {
    it("adds its own listeners instead of assigning over the root's", () => {
        // An `onmessage =` assignment would silently drop the listener the root put on the socket
        // it accepted.
        const socket = new FakeSocket();
        socket.addEventListener('message', () => {});
        harness({ socket });

        expect(socket.listenerCount).toBe(4);
    });
});
