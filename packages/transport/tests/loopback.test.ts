import { describe, it, expect, vi } from 'vitest';
import { jsonCodec } from '../src/codec.js';
import { TransportError } from '../src/errors.js';
import { loopbackPair } from '../src/loopback.js';
import type { EncodedFrame, Message, Transport } from '../src/transport.js';

/** Collects everything an end receives, in delivery order. */
function collect(end: Transport): Message[] {
    const seen: Message[] = [];
    end.onMessage((m) => seen.push(m));
    return seen;
}

describe('loopbackPair — delivery is pumped, one tick out', () => {
    it('delivers nothing before deliver()', () => {
        const pair = loopbackPair();
        const seen = collect(pair.server);
        pair.client.send({ kind: 'input', tick: 1 });
        expect(seen).toEqual([]);
        pair.deliver();
        expect(seen).toEqual([{ kind: 'input', tick: 1 }]);
    });

    it('delivers a frame sent during a tick at the NEXT deliver()', () => {
        // A zero-latency loopback would let a game depend on a same-tick round trip that vanishes
        // the instant it is networked.
        const pair = loopbackPair();
        const onClient = collect(pair.client);

        // tick 1: drain (nothing), then the server steps and enqueues.
        pair.deliver();
        pair.server.send({ kind: 'state', tick: 1 });
        expect(onClient).toEqual([]);

        // tick 2: the top-of-tick drain delivers tick 1's output.
        pair.deliver();
        expect(onClient).toEqual([{ kind: 'state', tick: 1 }]);
    });

    it('holds a request and its answer one tick apart in each direction', () => {
        // The round trip a local playtest exercises: input at tick 1 is seen by the server at tick 2,
        // and its answer reaches the client at tick 3.
        const pair = loopbackPair();
        const onServer = collect(pair.server);
        const onClient = collect(pair.client);

        pair.client.send({ kind: 'request', name: 'buy' });
        expect(onServer).toEqual([]);

        pair.deliver();
        expect(onServer).toEqual([{ kind: 'request', name: 'buy' }]);
        pair.server.send({ kind: 'state', credits: 9 });
        expect(onClient).toEqual([]);

        pair.deliver();
        expect(onClient).toEqual([{ kind: 'state', credits: 9 }]);
    });

    it('preserves send order per direction', () => {
        // Order is meaning for the structural channel: destroy-then-spawn and spawn-then-destroy
        // leave different worlds.
        const pair = loopbackPair();
        const seen = collect(pair.client);
        for (let i = 0; i < 50; i++) pair.server.send({ seq: i });
        pair.deliver();
        expect(seen).toEqual(Array.from({ length: 50 }, (_, i) => ({ seq: i })));
    });

    it('keeps the two directions independent', () => {
        const pair = loopbackPair();
        const onServer = collect(pair.server);
        const onClient = collect(pair.client);
        pair.client.send('c1');
        pair.server.send('s1');
        pair.client.send('c2');
        pair.deliver();
        expect(onServer).toEqual(['c1', 'c2']);
        expect(onClient).toEqual(['s1']);
    });

    it('does not deliver a frame a handler sends during the same drain', () => {
        // No re-entrancy: a handler that sends while handling cannot recurse into delivery
        // mid-dispatch, which a synchronous transport would invite.
        const pair = loopbackPair();
        const onClient = collect(pair.client);
        pair.server.onMessage(() => pair.server.send('reply'));
        pair.client.send('ask');
        pair.deliver();
        expect(onClient).toEqual([]);
        pair.deliver();
        expect(onClient).toEqual(['reply']);
    });

    it('is idempotent when nothing is queued', () => {
        const pair = loopbackPair();
        const seen = collect(pair.server);
        pair.deliver();
        pair.deliver();
        expect(seen).toEqual([]);
    });
});

describe('loopbackPair — value semantics', () => {
    it('delivers a structurally equal but reference-distinct value', () => {
        const pair = loopbackPair();
        const seen = collect(pair.server);
        const sent = { nested: { list: [1, 2] } };
        pair.client.send(sent);
        pair.deliver();
        expect(seen[0]).toEqual(sent);
        expect(seen[0]).not.toBe(sent);
        expect((seen[0] as typeof sent).nested).not.toBe(sent.nested);
    });

    it('is unaffected by the sender mutating the value after send', () => {
        // Without this, local mode would let the server hand the client a live reference into its own
        // state, a game developed single-player would silently depend on it, and it would rubber-band
        // the instant it was networked.
        const pair = loopbackPair();
        const seen = collect(pair.client);
        const sent: { hp: number; tags: string[] } = { hp: 10, tags: ['a'] };
        pair.server.send(sent);
        sent.hp = 999;
        sent.tags.push('b');
        pair.deliver();
        expect(seen[0]).toEqual({ hp: 10, tags: ['a'] });
    });

    it('throws at the send call on a value the wire would silently transform', () => {
        const pair = loopbackPair();
        expect(() => pair.client.send({ x: undefined } as never)).toThrow(
            expect.objectContaining({ code: 'encode-rejected' }),
        );
        expect(() => pair.client.send({ t: Number.NaN })).toThrow(TransportError);
    });

    it('delivers nothing for a rejected send', () => {
        const pair = loopbackPair();
        const seen = collect(pair.server);
        expect(() => pair.client.send({ fn: () => 1 } as never)).toThrow(TransportError);
        pair.deliver();
        expect(seen).toEqual([]);
    });

    it('uses the injected codec', () => {
        const codec = {
            encode: vi.fn(jsonCodec.encode),
            decode: vi.fn(jsonCodec.decode),
            byteLength: vi.fn(jsonCodec.byteLength),
        };
        const pair = loopbackPair({ codec });
        const seen = collect(pair.server);
        pair.client.send({ a: 1 });
        expect(codec.encode).toHaveBeenCalledTimes(1);
        expect(codec.decode).not.toHaveBeenCalled(); // decode is paid on delivery
        pair.deliver();
        expect(codec.decode).toHaveBeenCalledTimes(1);
        expect(seen).toEqual([{ a: 1 }]);
    });

    it('defaults to jsonCodec', () => {
        const pair = loopbackPair();
        const seen = collect(pair.server);
        pair.client.send({ a: 'héllo 😀' });
        pair.deliver();
        expect(seen).toEqual([{ a: 'héllo 😀' }]);
    });
});

describe('loopbackPair — encode-once fan-out', () => {
    it('delivers N reference-distinct copies from one encode, validating once', () => {
        const codec = {
            encode: vi.fn(jsonCodec.encode),
            decode: vi.fn(jsonCodec.decode),
            byteLength: vi.fn(jsonCodec.byteLength),
        };
        // The server holds one Transport per connected player and broadcasts by encoding once and
        // calling sendEncoded per connection.
        const pairs = [0, 1, 2].map(() => loopbackPair({ codec }));
        const seen = pairs.map((p) => collect(p.client));

        const op = { kind: 'spawn', id: 'e42', template: 'coin' };
        const frame = codec.encode(op);
        for (const p of pairs) p.server.sendEncoded(frame);
        for (const p of pairs) p.deliver();

        expect(codec.encode).toHaveBeenCalledTimes(1); // validated and encoded exactly once
        for (const s of seen) expect(s).toEqual([op]);
        expect(seen[0]?.[0]).not.toBe(seen[1]?.[0]);
        expect(seen[1]?.[0]).not.toBe(seen[2]?.[0]);
    });

    it('completes a fan-out loop over a mix of open and closed ends', () => {
        // One dead peer is a local event, not a global failure.
        const pairs = [0, 1, 2].map(() => loopbackPair());
        const seen = pairs.map((p) => collect(p.client));
        pairs[1]?.server.close();

        const frame = jsonCodec.encode({ kind: 'tick' });
        expect(() => {
            for (const p of pairs) p.server.sendEncoded(frame);
        }).not.toThrow();
        for (const p of pairs) p.deliver();

        expect(seen[0]).toEqual([{ kind: 'tick' }]);
        expect(seen[1]).toEqual([]);
        expect(seen[2]).toEqual([{ kind: 'tick' }]);
    });

    it('accepts a frame encoded by the process codec outside the transport', () => {
        // sendEncoded's premise: the server encodes with the process codec and hands the frame to a
        // connection that never called its own encode.
        const pair = loopbackPair();
        const seen = collect(pair.server);
        pair.client.sendEncoded(jsonCodec.encode({ a: 1 }));
        pair.deliver();
        expect(seen).toEqual([{ a: 1 }]);
    });

    it('propagates a decode failure on delivery rather than swallowing it', () => {
        // A frame that will not decode can only be a composition-root bug in loopback — the sender's
        // own codec produced it — so it must surface, not vanish.
        const pair = loopbackPair();
        pair.server.onMessage(() => {});
        pair.client.sendEncoded('{not json' as EncodedFrame);
        expect(() => pair.deliver()).toThrow(expect.objectContaining({ code: 'malformed-frame' }));
    });

    it('reports byte-accurate depth through the codec, not string .length', () => {
        // For a JSON string, .length is UTF-16 code units, which undercounts every non-ASCII
        // character in a player name and is off by 2× on emoji.
        const frame = jsonCodec.encode({ name: '😀😀' });
        expect(typeof frame).toBe('string');
        expect(jsonCodec.byteLength(frame)).toBeGreaterThan((frame as string).length);
    });
});

describe('loopbackPair — retention', () => {
    it('flushes frames that arrived before a handler registered, in order', () => {
        // deliver() can run before an end has called onMessage; the join sequence races wiring order.
        // Discarding them would lose join messages depending on which end wired first — a bug that
        // surfaces only under specific timing and only sometimes.
        const pair = loopbackPair();
        pair.client.send('a');
        pair.client.send('b');
        pair.deliver();
        pair.client.send('c');
        pair.deliver();

        const seen = collect(pair.server);
        expect(seen).toEqual(['a', 'b', 'c']);
    });

    it('retains again after a disposer runs, rather than dropping', () => {
        // Stated because "drop while unhandled" is the natural accidental implementation.
        const pair = loopbackPair();
        const first: Message[] = [];
        const dispose = pair.server.onMessage((m) => first.push(m));
        pair.client.send('a');
        pair.deliver();
        expect(first).toEqual(['a']);

        dispose();
        pair.client.send('b');
        pair.client.send('c');
        pair.deliver();
        expect(first).toEqual(['a']); // the disposed handler sees nothing more

        const second = collect(pair.server);
        expect(second).toEqual(['b', 'c']); // retained across the gap, flushed on register
    });

    it('retains across close and flushes before onClose', () => {
        const pair = loopbackPair();
        pair.client.send('a');
        pair.client.send('b');
        pair.client.close();
        pair.deliver();

        const order: string[] = [];
        pair.server.onClose(() => order.push('close'));
        expect(order).toEqual([]); // frames are still ahead of the marker
        pair.server.onMessage((m) => order.push(`msg:${String(m)}`));
        expect(order).toEqual(['msg:a', 'msg:b', 'close']);
    });

    it('retains the rest when a handler disposes itself mid-drain', () => {
        // Shift-as-we-go rather than a snapshot: the remaining frames must not be delivered into a
        // closure the caller has just unhooked.
        const pair = loopbackPair();
        const first: Message[] = [];
        const dispose = pair.server.onMessage((m) => {
            first.push(m);
            if (m === 'a') dispose();
        });
        pair.client.send('a');
        pair.client.send('b');
        pair.deliver();
        expect(first).toEqual(['a']);

        const second = collect(pair.server);
        expect(second).toEqual(['b']);
    });

    it('keeps frames behind a throwing handler queued for the next drain', () => {
        // A creator's handler throwing is an ordinary event; it must not eat the frames that had not
        // been delivered yet.
        const pair = loopbackPair();
        const seen: Message[] = [];
        pair.server.onMessage((m) => {
            seen.push(m);
            if (m === 'b') throw new Error('boom');
        });
        pair.client.send('a');
        pair.client.send('b');
        pair.client.send('c');
        expect(() => pair.deliver()).toThrow('boom');
        expect(seen).toEqual(['a', 'b']);
        pair.deliver();
        expect(seen).toEqual(['a', 'b', 'c']);
    });

    it('flushes on register without waiting for another deliver()', () => {
        const pair = loopbackPair();
        pair.client.send('a');
        pair.deliver();
        const seen = collect(pair.server);
        expect(seen).toEqual(['a']);
    });
});

describe('loopbackPair — ordered close, no re-entrancy, sealed both ways', () => {
    it('delivers a frame sent immediately before close() before the peer onClose', () => {
        const pair = loopbackPair();
        const order: string[] = [];
        pair.server.onMessage((m) => order.push(`msg:${String(m)}`));
        pair.server.onClose(() => order.push('close'));

        pair.client.send('last');
        pair.client.close();
        pair.deliver();
        expect(order).toEqual(['msg:last', 'close']);
    });

    it('fires onClose on deliver(), never synchronously inside close()', () => {
        // A synchronous onClose would re-enter the caller's stack mid-drain.
        const pair = loopbackPair();
        const onClose = vi.fn();
        pair.server.onClose(onClose);
        pair.client.close();
        expect(onClose).not.toHaveBeenCalled();
        pair.deliver();
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('fires the closer own onClose too, on its next drain', () => {
        // Teardown has one code path on both ends.
        const pair = loopbackPair();
        const onLocal = vi.fn();
        const onPeer = vi.fn();
        pair.client.onClose(onLocal);
        pair.server.onClose(onPeer);
        pair.client.close();
        pair.deliver();
        expect(onLocal).toHaveBeenCalledTimes(1);
        expect(onPeer).toHaveBeenCalledTimes(1);
    });

    it('fires onClose exactly once, even when both ends close', () => {
        const pair = loopbackPair();
        const onClient = vi.fn();
        const onServer = vi.fn();
        pair.client.onClose(onClient);
        pair.server.onClose(onServer);
        pair.client.close();
        pair.server.close();
        pair.deliver();
        pair.deliver();
        expect(onClient).toHaveBeenCalledTimes(1);
        expect(onServer).toHaveBeenCalledTimes(1);
    });

    it('makes a second close() a no-op', () => {
        const pair = loopbackPair();
        const onClose = vi.fn();
        pair.server.onClose(onClose);
        expect(() => {
            pair.client.close();
            pair.client.close();
            pair.client.close();
        }).not.toThrow();
        pair.deliver();
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('no-ops send and sendEncoded after close, without throwing', () => {
        const pair = loopbackPair();
        const seen = collect(pair.server);
        pair.client.close();
        pair.deliver();
        expect(() => pair.client.send('after')).not.toThrow();
        expect(() => pair.client.sendEncoded(jsonCodec.encode('after'))).not.toThrow();
        pair.deliver();
        expect(seen).toEqual([]);
    });

    it('drops a peer send into a closed end rather than queueing it forever', () => {
        // The peer does not learn of the close until it drains the marker, and in that window a peer
        // send would otherwise land in an inbox nothing will ever drain.
        const pair = loopbackPair();
        pair.server.close(); // the server end is closed; the client has not drained its marker yet
        expect(() => pair.client.send('into the void')).not.toThrow();

        const onServer = collect(pair.server);
        const closed = vi.fn();
        pair.server.onClose(closed);
        pair.deliver();
        expect(onServer).toEqual([]);
        expect(closed).toHaveBeenCalledTimes(1);
    });

    it('delivers frames already queued when a handler closes mid-drain', () => {
        // Strict FIFO: the frames arrived before the close decision, so they are ahead of the marker.
        const pair = loopbackPair();
        const order: string[] = [];
        pair.server.onMessage((m) => {
            order.push(`msg:${String(m)}`);
            if (m === 'a') pair.server.close();
        });
        pair.server.onClose(() => order.push('close'));
        pair.client.send('a');
        pair.client.send('b');
        pair.deliver();
        expect(order).toEqual(['msg:a', 'msg:b', 'close']);
    });

    it('does not re-fire onClose after the handler threw', () => {
        const pair = loopbackPair();
        let fired = 0;
        pair.server.onClose(() => {
            fired++;
            throw new Error('boom');
        });
        pair.client.close();
        expect(() => pair.deliver()).toThrow('boom');
        pair.deliver();
        expect(fired).toBe(1);
    });

    it('drops a send from inside onClose when the receiving end sealed its own inbox', () => {
        // The client closed, so ITS inbox is sealed; the server's goodbye frame from onClose is
        // dropped rather than queued into something nothing will drain.
        const pair = loopbackPair();
        const onClient = collect(pair.client);
        pair.server.onClose(() => pair.server.send('bye'));
        pair.client.close();
        pair.deliver();
        expect(onClient).toEqual([]);
    });

    it('survives a close with no handlers registered at all', () => {
        const pair = loopbackPair();
        pair.client.send('a');
        pair.client.close();
        expect(() => {
            pair.deliver();
            pair.deliver();
        }).not.toThrow();
    });
});

describe('loopbackPair — latency is a knob whose default is the one-tick delay', () => {
    it('defaults to one tick', () => {
        const pair = loopbackPair();
        const seen = collect(pair.server);
        pair.client.send('a');
        expect(seen).toEqual([]);
        pair.deliver();
        expect(seen).toEqual(['a']);
    });

    it('treats an explicit latency of 1 as identical to the default', () => {
        const pair = loopbackPair({ latency: 1 });
        const seen = collect(pair.server);
        pair.client.send('a');
        expect(seen).toEqual([]);
        pair.deliver();
        expect(seen).toEqual(['a']);
    });

    it('delivers within the same deliver() at latency 0', () => {
        // What buys the diagnosis: a desync that survives latency 0 is a simulation bug, and one that
        // vanishes is a prediction bug.
        const pair = loopbackPair({ latency: 0 });
        const order: string[] = [];
        pair.server.onMessage((m) => {
            order.push(`server:${String(m)}`);
            pair.server.send('pong');
        });
        pair.client.onMessage((m) => order.push(`client:${String(m)}`));

        pair.client.send('ping');
        pair.deliver();
        // The full round trip inside one deliver(), which is what latency 1 spends two on.
        expect(order).toEqual(['server:ping', 'client:pong']);
    });

    it('still delivers nothing outside deliver(), even at latency 0', () => {
        // Zero latency is not synchronous delivery: a handler still cannot be re-entered from inside
        // the sender's own stack.
        const pair = loopbackPair({ latency: 0 });
        const seen = collect(pair.server);
        pair.client.send('a');
        expect(seen).toEqual([]);
        pair.deliver();
        expect(seen).toEqual(['a']);
    });

    it('holds a frame for N deliver() calls at latency N', () => {
        const pair = loopbackPair({ latency: 3 });
        const seen = collect(pair.server);
        pair.client.send('a');
        pair.deliver();
        expect(seen).toEqual([]);
        pair.deliver();
        expect(seen).toEqual([]);
        pair.deliver();
        expect(seen).toEqual(['a']);
    });

    it('keeps FIFO order at a raised latency, so nothing overtakes', () => {
        // A delay must not become a reorder.
        const pair = loopbackPair({ latency: 2 });
        const seen = collect(pair.server);
        pair.client.send('a');
        pair.deliver();
        pair.client.send('b');
        pair.deliver();
        expect(seen).toEqual(['a']);
        pair.deliver();
        expect(seen).toEqual(['a', 'b']);
    });

    it('delays close by the same latency as a frame, still behind it', () => {
        const pair = loopbackPair({ latency: 2 });
        const order: string[] = [];
        pair.server.onMessage((m) => order.push(`msg:${String(m)}`));
        pair.server.onClose(() => order.push('close'));
        pair.client.send('last');
        pair.client.close();
        pair.deliver();
        expect(order).toEqual([]);
        pair.deliver();
        expect(order).toEqual(['msg:last', 'close']);
    });

    it('fires close on the first deliver() at latency 0, still after the frame ahead of it', () => {
        const pair = loopbackPair({ latency: 0 });
        const order: string[] = [];
        pair.server.onMessage((m) => order.push(`msg:${String(m)}`));
        pair.server.onClose(() => order.push('close'));
        pair.client.send('last');
        pair.client.close();
        pair.deliver();
        expect(order).toEqual(['msg:last', 'close']);
    });

    it('retains across a raised latency until a handler registers', () => {
        const pair = loopbackPair({ latency: 2 });
        pair.client.send('a');
        pair.deliver();
        pair.deliver();
        const seen = collect(pair.server);
        expect(seen).toEqual(['a']);
    });

    it('names a mutually-answering pair at latency 0 rather than hanging', () => {
        // At zero latency each reply is eligible in the same deliver(), so two handlers answering
        // each other never settle.
        const pair = loopbackPair({ latency: 0 });
        pair.server.onMessage(() => pair.server.send('pong'));
        pair.client.onMessage(() => pair.client.send('ping'));
        pair.client.send('ping');
        expect(() => pair.deliver()).toThrow(
            expect.objectContaining({ code: 'delivery-not-quiescent' }),
        );
    });

    it('rejects a latency that cannot count deliver() calls', () => {
        for (const latency of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(() => loopbackPair({ latency })).toThrow(
                expect.objectContaining({ code: 'invalid-option' }),
            );
        }
    });
});

describe('loopbackPair — the pump is not re-entrant', () => {
    it('refuses a deliver() from inside a handler', () => {
        // Nested pumping ages both queues twice in one tick, so a frame arrives earlier than latency
        // promises. The host loop owns the tick.
        const pair = loopbackPair();
        pair.server.onMessage(() => pair.deliver());
        pair.client.send('a');
        expect(() => pair.deliver()).toThrow(
            expect.objectContaining({ code: 'delivery-reentered' }),
        );
    });

    it('keeps counting deliver() calls when a handler tries to pump', () => {
        // The bug the guard exists for: at latency 2 a nested pump delivered 'b' at tick 2 instead of
        // tick 3. Now the nested call fails and the schedule is intact.
        const pair = loopbackPair({ latency: 2 });
        const arrivedAt: Record<string, number> = {};
        let tick = 0;
        pair.server.onMessage((m) => {
            arrivedAt[String(m)] ??= tick;
        });
        pair.client.send('a');
        for (tick = 1; tick <= 4; tick++) {
            if (tick === 2) pair.client.send('b');
            pair.deliver();
        }
        expect(arrivedAt).toEqual({ a: 2, b: 3 });
    });

    it('does not latch the pump when a handler throws', () => {
        // A creator's handler throwing is ordinary; if the guard stayed set the connection would go
        // quiet for good.
        const pair = loopbackPair();
        const seen: Message[] = [];
        pair.server.onMessage((m) => {
            seen.push(m);
            if (m === 'boom') throw new Error('boom');
        });
        pair.client.send('boom');
        expect(() => pair.deliver()).toThrow('boom');
        pair.client.send('after');
        expect(() => pair.deliver()).not.toThrow();
        expect(seen).toEqual(['boom', 'after']);
    });
});

describe('loopbackPair — an end exposes only the Transport surface', () => {
    it('hides the pump members from a consumer holding one end', () => {
        // `link` could re-point a live pair at a third end and `receive` could enqueue a frame that
        // never passed encode, both past the EncodedFrame brand. A TypeScript `private` is erased and
        // would not have stopped either.
        const pair = loopbackPair();
        for (const member of ['link', 'receive', 'age', 'drain', 'deliverable']) {
            expect(member in pair.client).toBe(false);
            expect(member in pair.server).toBe(false);
        }
    });

    it('still satisfies the whole Transport contract', () => {
        const pair = loopbackPair();
        for (const member of ['send', 'sendEncoded', 'onMessage', 'onClose', 'close']) {
            expect(typeof (pair.client as unknown as Record<string, unknown>)[member]).toBe(
                'function',
            );
        }
    });
});

describe('loopbackPair — retention is capped', () => {
    it('throws retention-overflow once frames for an absent handler pass the cap', () => {
        // Retaining until a handler registers is right; retaining without a cap is a leak — a
        // connection whose join sequence throws before wiring onMessage grows forever.
        const pair = loopbackPair({ maxRetainedBytes: 256 });
        for (let i = 0; i < 100; i++) pair.client.send({ payload: 'x'.repeat(50) });
        expect(() => pair.deliver()).toThrow(
            expect.objectContaining({ code: 'retention-overflow' }),
        );
    });

    it('surfaces on the host loop, not in the sender fan-out', () => {
        // The overflow is detected on the SENDER's stack, but throwing there would abort a server's
        // broadcast over its other connections.
        const pair = loopbackPair({ maxRetainedBytes: 128 });
        expect(() => {
            for (let i = 0; i < 50; i++) pair.client.send({ payload: 'y'.repeat(50) });
        }).not.toThrow();
        expect(() => pair.deliver()).toThrow(
            expect.objectContaining({ code: 'retention-overflow' }),
        );
    });

    it('stops growing rather than queueing what it reported', () => {
        const pair = loopbackPair({ maxRetainedBytes: 200 });
        for (let i = 0; i < 100; i++) pair.client.send({ payload: 'z'.repeat(50) });
        expect(() => pair.deliver()).toThrow(TransportError);

        // Whatever fit is still delivered, but the overflow is not replayed and the inbox did not
        // grow to 100 frames.
        const seen = collect(pair.server);
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.length).toBeLessThan(10);
    });

    it('does not fire again on the next deliver() for the same overflow', () => {
        const pair = loopbackPair({ maxRetainedBytes: 128 });
        for (let i = 0; i < 50; i++) pair.client.send({ payload: 'q'.repeat(50) });
        expect(() => pair.deliver()).toThrow(TransportError);
        expect(() => pair.deliver()).not.toThrow();
    });

    it('does not cap a backlog behind a registered handler', () => {
        // A backlog behind a live handler is the pump running late, which backpressure above the
        // transport answers. Only frames waiting on a handler that may never arrive are the leak.
        const pair = loopbackPair({ maxRetainedBytes: 256 });
        const seen = collect(pair.server);
        for (let i = 0; i < 100; i++) pair.client.send({ payload: 'x'.repeat(50) });
        expect(() => pair.deliver()).not.toThrow();
        expect(seen).toHaveLength(100);
    });

    it('releases the retained count as frames are delivered', () => {
        // The cap bounds what is UNDELIVERED, so a connection that wires late and then keeps up must
        // not accumulate credit against it.
        const pair = loopbackPair({ maxRetainedBytes: 512 });
        for (let i = 0; i < 4; i++) pair.client.send({ payload: 'x'.repeat(50) });
        pair.deliver();
        const seen = collect(pair.server);
        expect(seen).toHaveLength(4);
        for (let i = 0; i < 200; i++) {
            pair.client.send({ payload: 'x'.repeat(50) });
            pair.deliver();
        }
        expect(seen).toHaveLength(204);
    });

    it('counts bytes through the codec, not frame count', () => {
        const codec = {
            encode: vi.fn(jsonCodec.encode),
            decode: vi.fn(jsonCodec.decode),
            byteLength: vi.fn(jsonCodec.byteLength),
        };
        const pair = loopbackPair({ codec, maxRetainedBytes: 4096 });
        pair.client.send({ a: 1 });
        // An emoji is 4 bytes and 2 UTF-16 units, so a count off the string length would under-charge
        // a real payload.
        expect(codec.byteLength).toHaveBeenCalled();
    });

    it('never drops a close marker to enforce the cap', () => {
        // The marker is one entry with no payload and is how the peer learns the connection ended.
        const pair = loopbackPair({ maxRetainedBytes: 64 });
        for (let i = 0; i < 50; i++) pair.client.send({ payload: 'x'.repeat(50) });
        pair.client.close();

        const closed = vi.fn();
        pair.server.onClose(closed);
        expect(() => pair.deliver()).toThrow(
            expect.objectContaining({ code: 'retention-overflow' }),
        );
        pair.server.onMessage(() => {});
        pair.deliver();
        expect(closed).toHaveBeenCalledTimes(1);
    });

    it('rejects a non-positive cap', () => {
        for (const maxRetainedBytes of [0, -1, Number.NaN]) {
            expect(() => loopbackPair({ maxRetainedBytes })).toThrow(
                expect.objectContaining({ code: 'invalid-option' }),
            );
        }
    });

    it('retains a normal join sequence without tripping the default cap', () => {
        // The default must be irrelevant to real traffic: a join sequence is a handful of frames.
        const pair = loopbackPair();
        for (let i = 0; i < 500; i++) pair.client.send({ kind: 'join', seq: i });
        pair.deliver();
        const seen = collect(pair.server);
        expect(seen).toHaveLength(500);
    });
});

describe('loopbackPair — sendEncoded takes only a codec-minted frame', () => {
    it('accepts a frame from the injected codec', () => {
        const pair = loopbackPair();
        const seen = collect(pair.server);
        pair.client.sendEncoded(jsonCodec.encode({ a: 1 }));
        pair.deliver();
        expect(seen).toEqual([{ a: 1 }]);
    });

    it('rejects a hand-built frame at the type level', () => {
        // The soundness of sendEncoded rests on the frame having come from the process codec, which
        // used to be a convention the caller had to remember: a bare string type-checked and failed
        // at the FAR end's decode, off the call site.
        const pair = loopbackPair();
        // @ts-expect-error a bare string is not an EncodedFrame
        expect(() => pair.client.sendEncoded('{"a":1}')).not.toThrow();
        // @ts-expect-error nor is a Uint8Array a binary codec might have produced
        expect(() => pair.client.sendEncoded(new Uint8Array([1]))).not.toThrow();
    });
});

describe('loopbackPair — one handler per end', () => {
    it('throws on a second onMessage while one is live', () => {
        // Two consumers of one connection would silently split its frames between them.
        const pair = loopbackPair();
        pair.server.onMessage(() => {});
        expect(() => pair.server.onMessage(() => {})).toThrow(
            expect.objectContaining({ code: 'handler-already-registered' }),
        );
    });

    it('throws on a second onClose while one is live', () => {
        const pair = loopbackPair();
        pair.server.onClose(() => {});
        expect(() => pair.server.onClose(() => {})).toThrow(
            expect.objectContaining({ code: 'handler-already-registered' }),
        );
    });

    it('accepts a new handler after the disposer runs', () => {
        const pair = loopbackPair();
        const dispose = pair.server.onMessage(() => {});
        dispose();
        expect(() => pair.server.onMessage(() => {})).not.toThrow();
        const disposeClose = pair.server.onClose(() => {});
        disposeClose();
        expect(() => pair.server.onClose(() => {})).not.toThrow();
    });

    it('makes a stale disposer harmless after re-registration', () => {
        const pair = loopbackPair();
        const disposeFirst = pair.server.onMessage(() => {});
        disposeFirst();
        const seen = collect(pair.server);
        disposeFirst(); // stale: must not unhook the current handler
        pair.client.send('a');
        pair.deliver();
        expect(seen).toEqual(['a']);
    });

    it('lets the two ends of one pair each hold their own handler', () => {
        const pair = loopbackPair();
        expect(() => {
            pair.client.onMessage(() => {});
            pair.server.onMessage(() => {});
            pair.client.onClose(() => {});
            pair.server.onClose(() => {});
        }).not.toThrow();
    });
});
