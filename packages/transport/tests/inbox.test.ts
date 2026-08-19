import { describe, it, expect } from 'vitest';
import { jsonCodec } from '../src/codec.js';
import { TransportError } from '../src/errors.js';
import type { InboxPolicy } from '../src/inbox.js';
import { FrameInbox, validateRetentionCap } from '../src/inbox.js';
import type { Message } from '../src/transport.js';

/** The queue both backends stand on, driven directly so each policy is pinned on its own. */
interface Harness {
    readonly inbox: FrameInbox;
    /** Every `onOverflow` call, in order: what was retained and what the refused frame weighed. */
    readonly overflows: { retained: number; bytes: number }[];
    /** Every rejection handed to `onDecodeFailure`. */
    readonly decodeFailures: unknown[];
}

function harness(
    over: Partial<Pick<InboxPolicy, 'maxRetainedBytes' | 'onDecodeFailure'>> = {},
): Harness {
    const overflows: Harness['overflows'] = [];
    const decodeFailures: unknown[] = [];
    const inbox = new FrameInbox({
        codec: jsonCodec,
        maxRetainedBytes: over.maxRetainedBytes ?? 64,
        onOverflow: (retained, bytes) => overflows.push({ retained, bytes }),
        onDecodeFailure:
            over.onDecodeFailure ??
            ((error) => {
                decodeFailures.push(error);
            }),
    });
    return { inbox, overflows, decodeFailures };
}

function frame(value: Message): string {
    return jsonCodec.encode(value) as string;
}

describe('FrameInbox — one handler per kind', () => {
    it('refuses a second live onMessage with one message text', () => {
        const { inbox } = harness();
        inbox.registerMessage(() => {});
        expect(() => inbox.registerMessage(() => {})).toThrow(
            "onMessage is already registered on this end; a second handler would split this connection's frames between two consumers. Dispose the first, or fan out above the transport.",
        );
    });

    it('refuses a second live onClose with one message text', () => {
        const { inbox } = harness();
        inbox.registerClose(() => {});
        expect(() => inbox.registerClose(() => {})).toThrow(
            'onClose is already registered on this end. Dispose the first, or fan out above the transport.',
        );
    });

    it('codes both refusals handler-already-registered', () => {
        const { inbox } = harness();
        inbox.registerMessage(() => {});
        inbox.registerClose(() => {});
        for (const register of [
            () => inbox.registerMessage(() => {}),
            () => inbox.registerClose(() => {}),
        ]) {
            try {
                register();
                expect.unreachable('a second registration should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(TransportError);
                expect((error as TransportError).code).toBe('handler-already-registered');
            }
        }
    });

    it('accepts a replacement after the disposer runs, and ignores a stale one', () => {
        const { inbox } = harness();
        const dispose = inbox.registerMessage(() => {});
        dispose();
        const seen: Message[] = [];
        inbox.registerMessage((m) => seen.push(m));
        dispose();
        inbox.enqueue(frame({ tick: 1 }));
        inbox.drain();
        expect(seen).toEqual([{ tick: 1 }]);
    });
});

describe('FrameInbox — retention and its cap', () => {
    it('flushes what arrived before registration, in order', () => {
        const { inbox } = harness();
        inbox.enqueue(frame({ tick: 1 }));
        inbox.enqueue(frame({ tick: 2 }));
        const seen: Message[] = [];
        inbox.registerMessage((m) => seen.push(m));
        expect(seen).toEqual([{ tick: 1 }, { tick: 2 }]);
    });

    it('drops the frame past the cap and reports what was held and what it weighed', () => {
        const { inbox, overflows } = harness({ maxRetainedBytes: 40 });
        const small = frame('x'.repeat(30));
        inbox.enqueue(small);
        inbox.enqueue(small);
        const seen: Message[] = [];
        inbox.registerMessage((m) => seen.push(m));
        expect(seen).toEqual(['x'.repeat(30)]);
        expect(overflows).toEqual([{ retained: 32, bytes: 32 }]);
    });

    it('reports every refused frame, leaving the latch to the backend', () => {
        const { inbox, overflows } = harness({ maxRetainedBytes: 40 });
        for (let i = 0; i < 3; i++) inbox.enqueue(frame('x'.repeat(60)));
        expect(overflows).toHaveLength(3);
    });

    it('stops enforcing the cap once a handler is registered', () => {
        const { inbox, overflows } = harness({ maxRetainedBytes: 40 });
        const seen: Message[] = [];
        inbox.registerMessage((m) => seen.push(m));
        inbox.enqueue(frame('x'.repeat(200)));
        inbox.drain();
        expect(overflows).toEqual([]);
        expect(seen).toHaveLength(1);
    });

    it('releases delivered bytes, so retention resumes with an empty budget', () => {
        const { inbox, overflows } = harness({ maxRetainedBytes: 40 });
        const dispose = inbox.registerMessage(() => {});
        inbox.enqueue(frame('x'.repeat(30)));
        inbox.drain();
        dispose();
        inbox.enqueue(frame('x'.repeat(30)));
        expect(overflows).toEqual([]);
    });

    it('exempts the close marker from the cap', () => {
        const { inbox } = harness({ maxRetainedBytes: 40 });
        inbox.enqueue(frame('x'.repeat(30)));
        inbox.queueClose();
        let closed = false;
        inbox.registerMessage(() => {});
        inbox.registerClose(() => {
            closed = true;
        });
        expect(closed).toBe(true);
    });
});

describe('FrameInbox — ageing is opt-in', () => {
    it('holds a frame until as many age() passes as its due', () => {
        const { inbox } = harness();
        const seen: Message[] = [];
        inbox.registerMessage((m) => seen.push(m));
        inbox.enqueue(frame({ tick: 1 }), 2);

        inbox.drain();
        expect(seen).toEqual([]);
        inbox.age();
        inbox.drain();
        expect(seen).toEqual([]);
        inbox.age();
        inbox.drain();
        expect(seen).toEqual([{ tick: 1 }]);
    });

    it('delivers immediately when nothing passed a due, which is the socket path', () => {
        const { inbox } = harness();
        const seen: Message[] = [];
        inbox.registerMessage((m) => seen.push(m));
        inbox.enqueue(frame({ tick: 1 }));
        inbox.drain();
        expect(seen).toEqual([{ tick: 1 }]);
    });

    it('holds an already-due frame behind a waiting one, so a delay never reorders', () => {
        const { inbox } = harness();
        const seen: Message[] = [];
        inbox.registerMessage((m) => seen.push(m));
        inbox.enqueue(frame({ tick: 1 }), 1);
        inbox.enqueue(frame({ tick: 2 }), 0);

        inbox.drain();
        expect(seen).toEqual([]);
        inbox.age();
        inbox.drain();
        expect(seen).toEqual([{ tick: 1 }, { tick: 2 }]);
    });

    it('reports deliverable only for an eligible entry its handler exists for', () => {
        const { inbox } = harness();
        expect(inbox.deliverable).toBe(false);

        inbox.enqueue(frame({ tick: 1 }), 1);
        expect(inbox.deliverable).toBe(false);
        inbox.registerMessage(() => {});
        expect(inbox.deliverable).toBe(false);
        inbox.age();
        expect(inbox.deliverable).toBe(true);
        inbox.drain();
        expect(inbox.deliverable).toBe(false);

        inbox.queueClose();
        expect(inbox.deliverable).toBe(false);
        inbox.registerClose(() => {});
        expect(inbox.deliverable).toBe(false);
    });
});

describe('FrameInbox — the drain consumes one entry at a time', () => {
    it('leaves the frames behind a throwing handler queued', () => {
        const { inbox } = harness();
        const seen: Message[] = [];
        inbox.registerMessage((m) => {
            seen.push(m);
            if ((m as { tick: number }).tick === 1) throw new Error('boom');
        });
        inbox.enqueue(frame({ tick: 1 }));
        inbox.enqueue(frame({ tick: 2 }));
        expect(() => inbox.drain()).toThrow('boom');
        expect(seen).toEqual([{ tick: 1 }]);

        inbox.drain();
        expect(seen).toEqual([{ tick: 1 }, { tick: 2 }]);
    });

    it('retains the rest for the next registration when a handler disposes itself', () => {
        const { inbox } = harness();
        const first: Message[] = [];
        const dispose = inbox.registerMessage((m) => {
            first.push(m);
            dispose();
        });
        inbox.enqueue(frame({ tick: 1 }));
        inbox.enqueue(frame({ tick: 2 }));
        inbox.drain();
        expect(first).toEqual([{ tick: 1 }]);

        const second: Message[] = [];
        inbox.registerMessage((m) => second.push(m));
        expect(second).toEqual([{ tick: 2 }]);
    });

    it('fires onClose once behind every frame ahead of it, however late the marker is drained', () => {
        const { inbox } = harness();
        const order: string[] = [];
        inbox.enqueue(frame({ tick: 1 }));
        inbox.queueClose();
        inbox.queueClose();
        inbox.registerClose(() => order.push('close'));
        inbox.registerMessage((m) => order.push(`message ${JSON.stringify(m)}`));
        inbox.drain();
        expect(order).toEqual(['message {"tick":1}', 'close']);
    });

    it('keeps order across more entries than the compaction threshold', () => {
        const { inbox } = harness({ maxRetainedBytes: 1024 * 1024 });
        const seen: number[] = [];
        inbox.registerMessage((m) => seen.push((m as { tick: number }).tick));
        for (let tick = 0; tick < 3000; tick++) {
            inbox.enqueue(frame({ tick }));
            inbox.drain();
        }
        expect(seen).toHaveLength(3000);
        expect(seen[0]).toBe(0);
        expect(seen[2999]).toBe(2999);
    });

    it('delivers the retained tail once and in order after a partial drain compacts the queue', () => {
        const { inbox } = harness({ maxRetainedBytes: 1024 * 1024 });
        const seen: number[] = [];
        inbox.registerMessage((m) => seen.push((m as { tick: number }).tick));
        for (let tick = 0; tick < 3000; tick++) inbox.enqueue(frame({ tick }), tick < 1500 ? 0 : 1);
        inbox.drain();

        expect(seen).toHaveLength(1500);
        expect(seen[0]).toBe(0);
        expect(seen[1499]).toBe(1499);

        inbox.age();
        inbox.drain();
        expect(seen).toStrictEqual(Array.from({ length: 3000 }, (_, i) => i));
    });
});

describe('FrameInbox — the decode-failure policy decides', () => {
    it('propagates when the policy throws, leaving the rest queued', () => {
        const { inbox } = harness({
            onDecodeFailure: (error) => {
                throw error;
            },
        });
        const seen: Message[] = [];
        inbox.registerMessage((m) => seen.push(m));
        inbox.enqueue('{"__proto__":{}}');
        inbox.enqueue(frame({ tick: 2 }));

        try {
            inbox.drain();
            expect.unreachable('the drain should have propagated the rejection');
        } catch (error) {
            expect((error as TransportError).code).toBe('pollution-key');
        }
        expect(seen).toEqual([]);

        inbox.drain();
        expect(seen).toEqual([{ tick: 2 }]);
    });

    it('abandons the drain when the policy returns, leaving the rest queued', () => {
        const { inbox, decodeFailures } = harness();
        const seen: Message[] = [];
        inbox.registerMessage((m) => seen.push(m));
        inbox.enqueue('{"__proto__":{}}');
        inbox.enqueue(frame({ tick: 2 }));

        inbox.drain();
        expect(decodeFailures).toHaveLength(1);
        expect((decodeFailures[0] as TransportError).code).toBe('pollution-key');
        expect(seen).toEqual([]);

        inbox.drain();
        expect(seen).toEqual([{ tick: 2 }]);
        expect(decodeFailures).toHaveLength(1);
    });
});

describe('validateRetentionCap', () => {
    it('accepts a positive byte count', () => {
        expect(() => validateRetentionCap(1)).not.toThrow();
    });

    it('refuses zero, a negative and NaN with one message', () => {
        for (const value of [0, -1, Number.NaN]) {
            try {
                validateRetentionCap(value);
                expect.unreachable(`${String(value)} should have been refused`);
            } catch (error) {
                expect(error).toBeInstanceOf(TransportError);
                expect((error as TransportError).code).toBe('invalid-option');
                expect((error as TransportError).message).toBe(
                    `maxRetainedBytes must be a positive byte count; received ${String(value)}.`,
                );
            }
        }
    });
});
