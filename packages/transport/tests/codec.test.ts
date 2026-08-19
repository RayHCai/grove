import { describe, it, expect } from 'vitest';
import { RESERVED_KEYS, jsonCodec } from '../src/codec.js';
import { RESERVED_KEYS as barrelReservedKeys } from '../src/index.js';
import { TransportError } from '../src/errors.js';
import { runCodecContract } from '../src/testing/codec-contract.js';
import type { Message } from '../src/transport.js';

// The same call runs against the binary codec in `@platform/protocol` when it lands.
runCodecContract(() => jsonCodec, { name: 'jsonCodec — Codec contract' });

describe('jsonCodec — JSON specifics', () => {
    it('produces string frames', () => {
        expect(typeof jsonCodec.encode({ kind: 'spawn' })).toBe('string');
    });

    it('produces the frame JSON.stringify would, for an admissible value', () => {
        // Not a reimplementation of JSON: the validated copy stringifies identically, so a peer
        // running a stock JSON.parse — a debugging proxy, a log tail — reads it unchanged.
        const value = { kind: 'spawn', id: 'e42', at: [1, -2.5], meta: null };
        expect(jsonCodec.encode(value)).toBe(JSON.stringify(value));
    });

    it('rejects a binary frame on decode', () => {
        // A Uint8Array means the peer is running a different codec, which one codec per process rules
        // out — so this is a composition-root bug, reported as a malformed frame.
        expect(() => jsonCodec.decode(new Uint8Array([1, 2]))).toThrow(
            expect.objectContaining({ code: 'malformed-frame' }),
        );
    });

    it('reports byteLength for a binary frame without decoding it', () => {
        // A codec may be handed a frame it did not produce via sendEncoded, and backpressure
        // accounting runs before anything looks at contents.
        expect(jsonCodec.byteLength(new Uint8Array([1, 2, 3]))).toBe(3);
    });

    it('rejects the JSON literals that are not JSON', () => {
        for (const frame of ['NaN', 'Infinity', 'undefined', '', "{'a':1}", '{a:1}']) {
            expect(() => jsonCodec.decode(frame)).toThrow(
                expect.objectContaining({ code: 'malformed-frame' }),
            );
        }
    });

    it('carries a large payload intact', () => {
        const big = { entities: Array.from({ length: 2000 }, (_, i) => ({ id: `e${i}`, x: i })) };
        expect(jsonCodec.decode(jsonCodec.encode(big))).toEqual(big);
    });

    it('keeps float precision through the round trip', () => {
        // A position that lost its last bits would desync a synced script, so this is exact equality
        // rather than a tolerance.
        for (const n of [0.1, 1 / 3, 1e-7, 1.7976931348623157e308, 5e-324, 123456.789012345]) {
            expect(jsonCodec.decode(jsonCodec.encode({ n }))).toEqual({ n });
        }
    });

    it('names the pollution key it rejected', () => {
        expect(() => jsonCodec.decode('{"__proto__":1}')).toThrow(/__proto__/);
    });

    it('reports a pollution key nested under an admissible one', () => {
        expect(() => jsonCodec.decode('{"ok":{"deep":{"constructor":1}}}')).toThrow(
            expect.objectContaining({ code: 'pollution-key' }),
        );
    });

    it('throws TransportError, so a consumer can branch on code', () => {
        // The two regimes a consumer must tell apart: our bug crashes, their bug closes.
        const ours = (() => {
            try {
                jsonCodec.encode({ x: undefined } as never);
            } catch (e) {
                return e as TransportError;
            }
            return undefined;
        })();
        const theirs = (() => {
            try {
                jsonCodec.decode('{"__proto__":1}');
            } catch (e) {
                return e as TransportError;
            }
            return undefined;
        })();
        expect(ours).toBeInstanceOf(TransportError);
        expect(theirs).toBeInstanceOf(TransportError);
        expect(ours?.code).toBe('encode-rejected');
        expect(theirs?.code).toBe('pollution-key');
    });

    it('explains what to do instead, for each rejection a creator can cause', () => {
        // The person who wrote the handler is twelve, so the message names the fix rather than the rule.
        expect(() => jsonCodec.encode({ x: undefined } as never)).toThrow(/Send null/);
        expect(() => jsonCodec.encode({ t: Number.NaN })).toThrow(/sentinel|omit/);
        expect(() => jsonCodec.encode({ fn: () => 1 } as never)).toThrow(/ids/);
    });

    it('names the offending type, so the fix is obvious from the message alone', () => {
        // A live engine object reaching `send` unserialized is the mistake this text exists for, so
        // the class name has to survive into the message.
        class Coin {
            readonly id = 'e42';
        }
        const cases: ReadonlyArray<readonly [unknown, RegExp]> = [
            [{ a: new Map() }, /Map instance/],
            [{ a: new Set() }, /Set instance/],
            [{ a: new Date(0) }, /Date instance/],
            [{ a: /x/ }, /RegExp instance/],
            [{ a: new Uint8Array() }, /Uint8Array instance/],
            [{ a: new Coin() }, /Coin instance/],
            [{ a: 1n }, /BigInt \(1n\)/],
            [Object.create(null) as object, /prototype-less object/],
        ];
        for (const [value, expected] of cases) {
            expect(() => jsonCodec.encode(value as never)).toThrow(expected);
        }
    });

    it('names an array index in the path', () => {
        expect(() => jsonCodec.encode([1, [2, { x: Number.NaN }]])).toThrow(/\[1\]\[1\]\.x/);
    });

    it('says "the message root" for a rejection at the root', () => {
        expect(() => jsonCodec.encode(undefined as never)).toThrow(/the message root/);
        expect(() => jsonCodec.encode(Number.NaN)).toThrow(/the message root/);
    });

    it('round-trips a bare primitive frame', () => {
        // An envelope is normally an object, but nothing requires one.
        expect(jsonCodec.decode('"x"')).toBe('x');
        expect(jsonCodec.decode('5')).toBe(5);
        expect(jsonCodec.decode('true')).toBe(true);
        expect(jsonCodec.decode('null')).toBe(null);
    });

    it('reports zero bytes for an empty frame', () => {
        expect(jsonCodec.byteLength('')).toBe(0);
    });

    it('reports a pollution key inside an array element', () => {
        // The walk visits array elements as containers too, so a key one level inside an array is
        // still found.
        expect(() => jsonCodec.decode('[{"a":1},{"__proto__":{"x":1}}]')).toThrow(
            expect.objectContaining({ code: 'pollution-key' }),
        );
    });

    it('accepts an array index named like a pollution key without confusing the two', () => {
        // Array KEYS are indices, so the pollution check is skipped for them; a string element that
        // happens to read "constructor" is data, not a key.
        expect(jsonCodec.decode('["__proto__","constructor"]')).toEqual([
            '__proto__',
            'constructor',
        ]);
    });

    it('rejects a reserved key on encode, rather than emitting a frame decode refuses', () => {
        // Without this the codec produced `{"constructor":"wizard"}` and its own decode threw
        // pollution-key — a peer-fault code for a field a creator named, which closes the connection
        // and blames the wrong end.
        for (const key of ['__proto__', 'constructor', 'prototype']) {
            expect(() => jsonCodec.encode({ [key]: 1 })).toThrow(
                expect.objectContaining({ code: 'encode-rejected' }),
            );
        }
        expect(() => jsonCodec.encode({ hero: { constructor: 'wizard' } })).toThrow(/constructor/);
    });

    it('rejects an own __proto__ key rather than silently dropping it', () => {
        // Assignment to `copy.__proto__` hit the prototype setter, so the key vanished from the
        // frame: encode returned "{}" where JSON.stringify returned the key. Silent loss in the codec
        // whose reason for existing is that the wire must not transform a value quietly.
        const source = {};
        Object.defineProperty(source, '__proto__', {
            value: { polluted: true },
            enumerable: true,
            writable: true,
            configurable: true,
        });
        expect(Object.keys(source)).toEqual(['__proto__']);
        expect(() => jsonCodec.encode(source)).toThrow(
            expect.objectContaining({ code: 'encode-rejected' }),
        );
    });

    it('refuses a shared-reference graph that expands past the node budget', () => {
        // MAX_DEPTH bounds the ancestor chain, not the work: the copy is per REFERENCE, so sharing
        // one object between two fields at each level doubles per level. 30 objects nested 29 deep
        // used to exhaust the heap while sitting far inside the depth cap and far under any byte cap.
        let node: Message = { v: 1 };
        for (let i = 0; i < 29; i++) node = { a: node, b: node };
        expect(() => jsonCodec.encode(node)).toThrow(
            expect.objectContaining({ code: 'encode-rejected' }),
        );
        expect(() => jsonCodec.encode(node)).toThrow(/expands to more than/);
    });

    it('still accepts a large but honest payload', () => {
        // The budget must not trip on real traffic: this is bigger than any envelope and well under it.
        const big = { entities: Array.from({ length: 20_000 }, (_, i) => ({ id: `e${i}`, x: i })) };
        expect(() => jsonCodec.encode(big)).not.toThrow();
    });

    it('chains the parser error as the cause of a malformed frame', () => {
        // The parser's message names the byte offset, which is what a consumer debugging a mismatched
        // peer needs; discarding it left only "not valid JSON".
        try {
            jsonCodec.decode('{"a":');
            expect.unreachable('decode should have thrown');
        } catch (error) {
            expect(error).toBeInstanceOf(TransportError);
            expect((error as TransportError).cause).toBeInstanceOf(SyntaxError);
        }
    });

    it('does not invoke a getter while rejecting it', () => {
        let invoked = false;
        const value = {
            get boom() {
                invoked = true;
                return 1;
            },
        };
        expect(() => jsonCodec.encode(value)).toThrow(TransportError);
        expect(invoked).toBe(false);
    });

    it('rejects a getter that would have thrown, rather than surfacing its error', () => {
        const value = {
            get boom(): number {
                throw new Error('side effect');
            },
        };
        expect(() => jsonCodec.encode(value)).toThrow(TransportError);
    });
});

describe('RESERVED_KEYS', () => {
    it('holds the three keys the codec refuses, and reaches consumers through the barrel', () => {
        // A layer above may answer these keys differently — the server drops rather than refuses —
        // so the set is shared and the literal exists once.
        expect([...RESERVED_KEYS].toSorted()).toEqual(['__proto__', 'constructor', 'prototype']);
        expect(barrelReservedKeys).toBe(RESERVED_KEYS);
    });

    it('names every key decode rejects with pollution-key', () => {
        for (const key of RESERVED_KEYS) {
            const frame = `{${JSON.stringify(key)}:{}}`;
            try {
                jsonCodec.decode(frame);
                expect.unreachable(`decode should have rejected ${key}`);
            } catch (error) {
                expect((error as TransportError).code).toBe('pollution-key');
            }
        }
    });
});
