// The reusable Codec conformance suite, exported as `@platform/transport/testing`.
//
// "Swapping the injected codec swaps the validator, so loopback stays a conservative model of
// whatever wire is live" is only TRUE if every codec actually validates, and a permissive `encode`
// one layer up would silently break it — so this is enforced completeness rather than discipline.
//
// It lives in `src/` behind a subpath export rather than in `tests/` because the binary codec lands
// in `@platform/protocol`, which sits ABOVE transport, while `tests/` is outside `dist` and outside
// `exports`: an acceptance gate the implementer cannot import is not a gate.
//
// CODEC-AGNOSTIC BY CONSTRUCTION: this file may only touch `Codec` members plus whatever arrives
// through `opts`. It never assumes a frame is a string, never parses one, and asserts byte counts
// only through `codec.byteLength`. Where codecs legitimately differ — JSON cannot carry a
// `Uint8Array`, a binary codec might — the expectation comes in through `opts`.

import { describe, it, expect } from 'vitest';
import type { Codec } from '../codec.js';
import type { Message } from '../transport.js';
import { TransportError } from '../errors.js';

export interface CodecContractOptions {
    /** Label for the describe block, so two codecs' results are told apart. */
    name?: string;
    /**
     * A frame this codec cannot have produced, for the `malformed-frame` case. Defaults to a
     * truncated JSON string; a binary codec supplies a byte sequence its header rejects.
     */
    malformedFrame?: unknown;
    /**
     * Builds a well-formed frame nesting `depth` levels, for the decode-side depth cap. Defaults to
     * nested JSON objects; a binary codec supplies its own nesting. Omit to skip.
     */
    makeDeepFrame?: (depth: number) => unknown;
    /** A nesting depth every codec must REFUSE on both directions, deep enough to overflow a recursive walk. */
    hostileDepth?: number;
    /**
     * A frame carrying a pollution key, in this codec's own encoding — it cannot be produced through
     * `encode`, which is the point. Omit to skip (a wire format with no object keys cannot express one).
     */
    pollutionFrames?: readonly unknown[];
    /** A frame carrying a non-finite number, again unproducible through `encode`. Omit to skip. */
    nonFiniteFrame?: unknown;
    /**
     * Builds a frame of roughly `bytes` wire bytes, for the decode-side byte cap. Defaults to a JSON
     * string of that length; a binary codec supplies its own. Omit to skip.
     */
    makeLargeFrame?: (bytes: number) => unknown;
    /** A wire size every codec must REFUSE, large enough that parsing it is itself the attack. */
    hostileBytes?: number;
}

/**
 * Declared rather than imported because `src/` pulls in neither `node` nor `DOM` types, so only the
 * one member the `byteLength` check needs is named — and that check is what pins a hand-rolled UTF-8
 * count to the real encoding instead of trusting it.
 */
declare const TextEncoder: new () => { encode(input: string): { readonly length: number } };

/**
 * Stands in for a live engine object reaching `send` unserialized. It stringifies to `{"id":"e42"}`,
 * so the peer would receive a plausible-looking object that is not an `Entity`.
 */
class EntityLike {
    constructor(readonly id: string) {}
}

/** Values every codec must REFUSE at encode, because the JSON wire drops or transforms them. */
const INADMISSIBLE: ReadonlyArray<{ what: string; make: () => unknown }> = [
    { what: 'undefined at the root', make: () => undefined },
    { what: 'undefined in an object', make: () => ({ x: undefined }) },
    { what: 'undefined in an array', make: () => [1, undefined, 3] },
    { what: 'NaN', make: () => ({ t: Number.NaN }) },
    { what: 'Infinity', make: () => ({ t: Number.POSITIVE_INFINITY }) },
    { what: '-Infinity', make: () => ({ t: Number.NEGATIVE_INFINITY }) },
    { what: 'a function', make: () => ({ fn: () => 1 }) },
    { what: 'a method shorthand', make: () => ({ fn() {} }) },
    { what: 'a symbol value', make: () => ({ s: Symbol('s') }) },
    { what: 'a BigInt', make: () => ({ n: 1n }) },
    { what: 'a Map', make: () => ({ m: new Map([['a', 1]]) }) },
    { what: 'a Set', make: () => ({ s: new Set([1]) }) },
    { what: 'a Date', make: () => ({ d: new Date(0) }) },
    { what: 'a RegExp', make: () => ({ r: /x/ }) },
    { what: 'a Uint8Array', make: () => ({ b: new Uint8Array([1, 2]) }) },
    { what: 'a class instance', make: () => ({ e: new EntityLike('e42') }) },
    { what: 'a prototype-less object', make: () => Object.create(null) as object },
    { what: 'a boxed number', make: () => ({ n: new Number(5) }) },
    {
        what: 'a getter',
        make: () => ({
            get boom() {
                return 1;
            },
        }),
    },
    {
        what: 'a toJSON method (it would replace the value silently)',
        make: () => ({ toJSON: () => 42 }),
    },
    {
        what: 'a direct cycle',
        make: () => {
            const a: Record<string, unknown> = {};
            a.self = a;
            return a;
        },
    },
    {
        what: 'an indirect cycle',
        make: () => {
            const a: Record<string, unknown> = {};
            const b: Record<string, unknown> = { a };
            a.b = b;
            return a;
        },
    },
    {
        what: 'a cycle through an array',
        make: () => {
            const a: unknown[] = [];
            a.push(a);
            return a;
        },
    },
];

/** A nested object `depth` levels deep, built iteratively so the FIXTURE itself cannot overflow. */
function deepValue(depth: number): Message {
    let node: Message = 1;
    for (let i = 0; i < depth; i++) node = { a: node };
    return node;
}

/** Values every codec must ACCEPT and round-trip unchanged. */
const ADMISSIBLE: ReadonlyArray<{ what: string; value: Message }> = [
    { what: 'null', value: null },
    { what: 'true', value: true },
    { what: 'false', value: false },
    { what: 'zero', value: 0 },
    { what: 'a negative integer', value: -42 },
    { what: 'a float', value: 1.5 },
    { what: 'the largest safe integer', value: Number.MAX_SAFE_INTEGER },
    { what: 'the smallest denormal', value: Number.MIN_VALUE },
    { what: 'an empty string', value: '' },
    { what: 'a string with quotes and backslashes', value: 'he said "\\hi\\"' },
    { what: 'a string with a newline and a tab', value: 'a\nb\tc' },
    { what: 'a non-ASCII string', value: 'héllo 日本語' },
    { what: 'an emoji string', value: '😀🎮' },
    { what: 'an empty array', value: [] },
    { what: 'an empty object', value: {} },
    { what: 'a nested structure', value: { a: [1, { b: null }, 'x'], c: { d: [] } } },
    { what: 'a key needing escapes', value: { 'a.b"c': 1 } },
    { what: 'an empty-string key', value: { '': 1 } },
    { what: 'a spawn envelope', value: { kind: 'spawn', id: 'e42', template: 'coin' } },
    {
        what: 'a deeply nested structure',
        value: { a: { b: { c: { d: { e: { f: { g: [1, 2, 3] } } } } } } },
    },
];

/** Runs the contract. Calls `describe`/`it` internally, so a caller is one line. */
export function runCodecContract(makeCodec: () => Codec, opts: CodecContractOptions = {}): void {
    const label = opts.name ?? 'Codec contract';
    const malformed = 'malformedFrame' in opts ? opts.malformedFrame : '{"a":';
    const pollutionFrames =
        opts.pollutionFrames ??
        ([
            '{"__proto__":{"polluted":true}}',
            '{"constructor":{"prototype":{"x":1}}}',
            '{"prototype":1}',
            '{"a":{"b":{"__proto__":{"x":1}}}}',
            '[{"__proto__":1}]',
        ] as const);
    const nonFinite = 'nonFiniteFrame' in opts ? opts.nonFiniteFrame : '{"a":1e999}';
    const hostileDepth = opts.hostileDepth ?? 20_000;
    const hostileBytes = opts.hostileBytes ?? 8 * 1024 * 1024;
    const makeLargeFrame =
        'makeLargeFrame' in opts
            ? opts.makeLargeFrame
            : (bytes: number): unknown => `{"a":"${'x'.repeat(Math.max(0, bytes - 10))}"}`;
    const makeDeepFrame =
        'makeDeepFrame' in opts
            ? opts.makeDeepFrame
            : (depth: number): string => `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`;

    describe(label, () => {
        describe('encode admission', () => {
            // Each of these throws at the send call, in the developer's local run, exactly where a
            // socket would have thrown or corrupted on the same forgotten encode.
            for (const { what, make } of INADMISSIBLE) {
                it(`rejects ${what}`, () => {
                    const codec = makeCodec();
                    expect(() => codec.encode(make() as Message)).toThrow(TransportError);
                    expect(() => codec.encode(make() as Message)).toThrow(
                        expect.objectContaining({ code: 'encode-rejected' }),
                    );
                });
            }

            it('names the offending path so the developer can find the field', () => {
                const codec = makeCodec();
                expect(() => codec.encode({ player: { stats: { hp: Number.NaN } } })).toThrow(
                    /player\.stats\.hp/,
                );
            });

            it('accepts the same object graph referenced twice — a DAG is not a cycle', () => {
                const codec = makeCodec();
                const shared = { hp: 1 };
                const decoded = codec.decode(codec.encode({ a: shared, b: shared })) as {
                    a: object;
                    b: object;
                };
                // Two independent copies, exactly as a socket would deliver it.
                expect(decoded).toEqual({ a: { hp: 1 }, b: { hp: 1 } });
                expect(decoded.a).not.toBe(decoded.b);
            });

            it('accepts a graph that revisits a sibling after unwinding', () => {
                const codec = makeCodec();
                const leaf = { v: 1 };
                expect(() => codec.encode([{ leaf }, { leaf }, { leaf }])).not.toThrow();
            });
        });

        describe('decode hostility', () => {
            for (const frame of pollutionFrames) {
                it(`rejects a frame carrying a pollution key: ${String(frame)}`, () => {
                    const codec = makeCodec();
                    expect(() => codec.decode(frame as never)).toThrow(
                        expect.objectContaining({ code: 'pollution-key' }),
                    );
                });
            }

            it('rejects rather than strips — nothing escapes decode', () => {
                const codec = makeCodec();
                // Rejected, so there is no partially-cleaned value to inspect.
                expect(() =>
                    codec.decode('{"__proto__":{"polluted":true},"a":1}' as never),
                ).toThrow(TransportError);
                expect(({} as Record<string, unknown>).polluted).toBeUndefined();
            });

            if (malformed !== undefined) {
                it('rejects a malformed frame', () => {
                    const codec = makeCodec();
                    expect(() => codec.decode(malformed as never)).toThrow(
                        expect.objectContaining({ code: 'malformed-frame' }),
                    );
                });
            }

            if (nonFinite !== undefined) {
                it('rejects a frame whose number overflows to non-finite', () => {
                    const codec = makeCodec();
                    // Well-formed on the wire, but a value `encode` refuses — the asymmetry between
                    // the two directions is what a hostile peer probes for.
                    expect(() => codec.decode(nonFinite as never)).toThrow(
                        expect.objectContaining({ code: 'unsupported-value' }),
                    );
                });
            }

            it('throws a TransportError, never a bare SyntaxError', () => {
                const codec = makeCodec();
                // Drop-and-close needs a machine-readable code, not message text.
                try {
                    codec.decode('not a frame at all' as never);
                    expect.unreachable('decode should have thrown');
                } catch (error) {
                    expect(error).toBeInstanceOf(TransportError);
                }
            });

            if (makeDeepFrame !== undefined) {
                it('refuses a deeply nested frame instead of exhausting the stack', () => {
                    const codec = makeCodec();
                    // The frame is well-formed and a few tens of KB — under any byte cap — so a size
                    // limit does not catch it. A TransportError closes the connection; a RangeError
                    // means the process is the attacker's.
                    expect(() => codec.decode(makeDeepFrame(hostileDepth) as never)).toThrow(
                        TransportError,
                    );
                });

                it('refuses it under a code the caller can act on, not a RangeError', () => {
                    const codec = makeCodec();
                    let thrown: unknown;
                    try {
                        codec.decode(makeDeepFrame(hostileDepth) as never);
                    } catch (error) {
                        thrown = error;
                    }
                    expect(thrown).toBeInstanceOf(TransportError);
                    expect(thrown).not.toBeInstanceOf(RangeError);
                    // Either code is defensible: the frame is well-formed, so `frame-too-deep` is
                    // precise, but a codec whose parser refuses the depth itself reports
                    // `malformed-frame`. Both are peer-fault codes.
                    expect(['frame-too-deep', 'malformed-frame']).toContain(
                        (thrown as TransportError).code,
                    );
                });

                it('still accepts nesting an ordinary envelope reaches', () => {
                    const codec = makeCodec();
                    // The cap must not be so tight that real payloads hit it.
                    expect(() => codec.decode(makeDeepFrame(16) as never)).not.toThrow();
                });
            }

            if (makeLargeFrame !== undefined) {
                it('refuses a frame over its byte cap, since parsing is what allocates', () => {
                    const codec = makeCodec();
                    let thrown: unknown;
                    try {
                        codec.decode(makeLargeFrame(hostileBytes) as never);
                    } catch (error) {
                        thrown = error;
                    }
                    expect(thrown).toBeInstanceOf(TransportError);
                    // As with depth: `frame-too-large` is precise, but a codec whose framing refuses
                    // the size first reports `malformed-frame`. Both are peer-fault codes.
                    expect(['frame-too-large', 'malformed-frame']).toContain(
                        (thrown as TransportError).code,
                    );
                });

                it('still accepts a frame an ordinary envelope reaches', () => {
                    const codec = makeCodec();
                    expect(() => codec.decode(makeLargeFrame(64 * 1024) as never)).not.toThrow();
                });
            }
        });

        describe('the two directions agree', () => {
            // The containment property: whatever `encode` emits, `decode` must accept. Without it the
            // two admissible sets drift apart — each direction is a separate walk over a separate
            // rule list — and the codec produces frames its own peer rejects under a code that blames
            // the sender.
            it('accepts every frame it produced, for each admissible value', () => {
                for (const { value } of ADMISSIBLE) {
                    const codec = makeCodec();
                    expect(() => codec.decode(codec.encode(value))).not.toThrow();
                }
            });

            it('handles a key that names a prototype slot the same way in both directions', () => {
                // A creator naming a field "constructor" is ordinary, so the two answers a codec may
                // give are refuse-on-encode or accept-on-both. Producing a frame that its own decode
                // refuses is the one answer that is wrong.
                for (const key of ['__proto__', 'constructor', 'prototype']) {
                    const codec = makeCodec();
                    let frame: unknown;
                    try {
                        frame = codec.encode({ [key]: 1 });
                    } catch (error) {
                        expect(error).toBeInstanceOf(TransportError);
                        expect((error as TransportError).code).toBe('encode-rejected');
                        continue;
                    }
                    expect(() => codec.decode(frame as never)).not.toThrow();
                }
            });
        });

        describe('depth is bounded on both directions', () => {
            it('refuses to encode a value nested past the cap', () => {
                const codec = makeCodec();
                // Capping only decode would leave a local send able to kill its own process.
                expect(() => codec.encode(deepValue(hostileDepth))).toThrow(TransportError);
            });

            it('reports it as our bug, since the value came from above the transport', () => {
                const codec = makeCodec();
                expect(() => codec.encode(deepValue(hostileDepth))).toThrow(
                    expect.objectContaining({ code: 'encode-rejected' }),
                );
            });

            it('round-trips nesting an ordinary envelope reaches', () => {
                const codec = makeCodec();
                const value = deepValue(16);
                expect(codec.decode(codec.encode(value))).toEqual(value);
            });

            it('accepts a wide DAG of shared leaves, which depth does not bound', () => {
                const codec = makeCodec();
                // Depth, not node count, is what the cap bounds: a wide graph of shared references is
                // legal however many nodes it has, so the two must not be conflated.
                const leaf = { v: 1 };
                const wide = Array.from({ length: 5_000 }, () => leaf);
                expect(() => codec.encode(wide)).not.toThrow();
            });
        });

        describe('round-trip identity and isolation', () => {
            for (const { what, value } of ADMISSIBLE) {
                it(`round-trips ${what}`, () => {
                    const codec = makeCodec();
                    expect(codec.decode(codec.encode(value))).toEqual(value);
                });
            }

            it('shares no reference with the source', () => {
                const codec = makeCodec();
                const source = { nested: { list: [1, 2] } };
                const decoded = codec.decode(codec.encode(source)) as typeof source;
                expect(decoded).toEqual(source);
                expect(decoded).not.toBe(source);
                expect(decoded.nested).not.toBe(source.nested);
                expect(decoded.nested.list).not.toBe(source.nested.list);
            });

            it('is unaffected by mutating the source after encode', () => {
                const codec = makeCodec();
                // The isolation a socket gives for free, and the reason local mode cannot come to
                // depend on a live reference into the server's own state.
                const source: { hp: number; tags: string[] } = { hp: 10, tags: ['a'] };
                const frame = codec.encode(source);
                source.hp = 999;
                source.tags.push('b');
                expect(codec.decode(frame)).toEqual({ hp: 10, tags: ['a'] });
            });

            it('normalizes -0 to 0, so a float64 wire cannot diverge from a JSON one', () => {
                const codec = makeCodec();
                // JSON cannot preserve the sign, so every codec normalizes and the two wires agree.
                expect(Object.is(codec.decode(codec.encode(-0)), 0)).toBe(true);
                const decoded = codec.decode(codec.encode({ vx: -0, list: [-0] })) as {
                    vx: number;
                    list: number[];
                };
                expect(Object.is(decoded.vx, 0)).toBe(true);
                expect(Object.is(decoded.list[0], 0)).toBe(true);
            });

            it('normalizes an array hole to null rather than rejecting it', () => {
                const codec = makeCodec();
                // Built by assignment rather than as a `[1, , 3]` literal, which the linter reads as
                // a typo.
                const sparse: number[] = [];
                sparse[0] = 1;
                sparse[2] = 3;
                expect(codec.decode(codec.encode(sparse))).toEqual([1, null, 3]);
            });

            it('preserves object key order', () => {
                const codec = makeCodec();
                const decoded = codec.decode(codec.encode({ z: 1, a: 2, m: 3 })) as object;
                expect(Object.keys(decoded)).toEqual(['z', 'a', 'm']);
            });

            it('round-trips a frame it produced for a value carrying a pollution-shaped STRING', () => {
                const codec = makeCodec();
                // The rejection is about KEYS, not characters: a chat message that happens to say
                // "__proto__" must still deliver.
                expect(codec.decode(codec.encode({ text: '__proto__' }))).toEqual({
                    text: '__proto__',
                });
            });
        });

        describe('byteLength', () => {
            it('reports UTF-8 bytes, not UTF-16 units', () => {
                const codec = makeCodec();
                // An emoji is 4 UTF-8 bytes and 2 UTF-16 units, so `.length` is off by 2× — the
                // normal case on an international K-12 platform, not the edge.
                const ascii = codec.encode({ a: 'hello' });
                const emoji = codec.encode({ a: '😀😀😀😀😀' });
                expect(codec.byteLength(emoji)).toBeGreaterThan(codec.byteLength(ascii));
                for (const frame of [ascii, emoji]) {
                    if (typeof frame !== 'string') continue;
                    expect(codec.byteLength(frame)).toBe(new TextEncoder().encode(frame).length);
                }
                if (typeof emoji === 'string') {
                    expect(codec.byteLength(emoji)).toBeGreaterThan(emoji.length);
                }
            });

            it('agrees with the encoding for a spread of scripts and widths', () => {
                const codec = makeCodec();
                for (const text of ['', 'a', 'ß', 'é', '日本語', '😀', 'a😀ß日', 'ÿࠀ']) {
                    const frame = codec.encode({ t: text });
                    if (typeof frame !== 'string') continue;
                    expect(codec.byteLength(frame)).toBe(new TextEncoder().encode(frame).length);
                }
            });

            it('is a non-negative integer for every admissible value', () => {
                const codec = makeCodec();
                for (const { value } of ADMISSIBLE) {
                    const bytes = codec.byteLength(codec.encode(value));
                    expect(Number.isInteger(bytes)).toBe(true);
                    expect(bytes).toBeGreaterThanOrEqual(0);
                }
            });

            it('grows with the payload, so depth accounting is monotone', () => {
                const codec = makeCodec();
                const small = codec.byteLength(codec.encode({ a: 'x' }));
                const large = codec.byteLength(codec.encode({ a: 'x'.repeat(1000) }));
                expect(large).toBeGreaterThan(small + 900);
            });
        });
    });
}
