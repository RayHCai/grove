import { describe, it, expect } from 'vitest';
import { MAX_FRAME_BYTES, RESERVED_KEYS, jsonCodec } from '../src/codec.js';
import { TransportError } from '../src/errors.js';
import type { Frame, Message } from '../src/transport.js';

// Every guard in this codec is otherwise pinned by the one shape its author thought of, in code that
// parses bytes from any peer on the internet — so each case here is generated instead, and each guard
// has a generated input that trips it.

/** Fixed, so a failure reproduces: every case derives its seed from this and prints it. */
const SEED = 0x5eed_0001;

/**
 * The codec's private nesting cap, mirrored rather than imported: a test that reads the constant it
 * is pinning moves with it and catches nothing.
 */
const MAX_DEPTH = 128;

interface Gen {
    /** Uniform in `[0, bound)`. */
    int(bound: number): number;
    pick<T>(items: readonly T[]): T;
    chance(probability: number): boolean;
}

/** splitmix32 — seeded, because a fuzz test that cannot reproduce its own failure is worse than none. */
function gen(seed: number): Gen {
    let state = seed >>> 0;
    const next = (): number => {
        state = (state + 0x9e37_79b9) >>> 0;
        let z = state;
        z = Math.imul(z ^ (z >>> 16), 0x21f0_aaad) >>> 0;
        z = Math.imul(z ^ (z >>> 15), 0x735a_2d97) >>> 0;
        return ((z ^ (z >>> 15)) >>> 0) / 0x1_0000_0000;
    };
    return {
        int: (bound) => Math.floor(next() * bound),
        pick: (items) => items[Math.floor(next() * items.length)] as never,
        chance: (probability) => next() < probability,
    };
}

/** Strings chosen for the boundaries the guards care about, not for coverage of the alphabet. */
const STRINGS: readonly string[] = [
    '',
    'a',
    'he said "\\hi\\"',
    'a\nb\tc\u0000\u001f',
    'héllo 日本語',
    '😀🎮',
    // Lone surrogates: unpaired on purpose, since `byteLength` and `JSON.stringify` each answer them
    // with a substitution rather than an error.
    '\ud800',
    '\udfff',
    'a\ud83dz',
    'trailing\ud83d',
    // The reserved words as DATA — a chat message saying "__proto__" must still deliver.
    '__proto__',
    'constructor',
    'prototype',
    'x'.repeat(2048),
];

const NUMBERS: readonly number[] = [
    0,
    -0,
    1,
    -1,
    0.1,
    1 / 3,
    -1e-7,
    1e21,
    Number.MAX_SAFE_INTEGER,
    -Number.MAX_SAFE_INTEGER,
    Number.MAX_VALUE,
    Number.MIN_VALUE,
];

/**
 * Keys that must round-trip. `toString`/`valueOf`/`hasOwnProperty` sit next to the reserved set
 * without being in it, which is the boundary a broader pollution check would cross.
 */
const KEYS: readonly string[] = [
    'a',
    'kind',
    '',
    'a.b"c',
    '0',
    'length',
    'toString',
    'valueOf',
    'hasOwnProperty',
    '日本',
    '😀',
    'k'.repeat(200),
];

function leaf(g: Gen): Message {
    switch (g.int(5)) {
        case 0:
            return null;
        case 1:
            return g.chance(0.5);
        case 2:
            return g.pick(NUMBERS);
        default:
            return g.pick(STRINGS);
    }
}

/** A value inside the admissible set, biased toward the shapes the caps are drawn around. */
function admissible(g: Gen, depthLeft: number, budget: { left: number }): Message {
    if (depthLeft <= 0 || budget.left <= 0 || g.chance(0.35)) return leaf(g);
    budget.left--;

    if (g.chance(0.45)) {
        if (g.chance(0.08)) {
            // Wide rather than deep: cardinality and depth bound different things, and only one of
            // them has a cap.
            const width = 200 + g.int(600);
            budget.left -= width;
            return Array.from({ length: width }, () => leaf(g));
        }
        const items = Array.from({ length: g.int(5) }, () => admissible(g, depthLeft - 1, budget));
        // A hole reads as `undefined` but stringifies to null, so it must survive as null.
        if (g.chance(0.15)) items.length += 1 + g.int(2);
        return items;
    }

    const object: Record<string, Message> = {};
    const size = g.int(6);
    for (let i = 0; i < size; i++) object[g.pick(KEYS)] = admissible(g, depthLeft - 1, budget);
    return object;
}

/** A container spine `depth` levels deep, mixing objects and arrays, built without recursing. */
function spine(g: Gen, depth: number): Message {
    let node: Message = 1;
    for (let i = 0; i < depth; i++) node = g.chance(0.5) ? [node] : { a: node };
    return node;
}

/** The same spine as a frame, so the decode side is fed depth the encode side cannot mint. */
function spineFrame(g: Gen, depth: number): string {
    let open = '';
    let close = '';
    for (let i = 0; i < depth; i++) {
        if (g.chance(0.5)) {
            open += '[';
            close = `]${close}`;
        } else {
            open += '{"a":';
            close = `}${close}`;
        }
    }
    return `${open}1${close}`;
}

/** Exactly `bytes` UTF-8 bytes across three widths, so the hand-rolled counter is what is measured. */
function padding(g: Gen, bytes: number): string {
    const wide = g.int(20);
    const mid = g.int(20);
    return '😀'.repeat(wide) + 'é'.repeat(mid) + 'x'.repeat(bytes - wide * 4 - mid * 2);
}

/** `EncodedFrame` is the wider `Frame`, narrowed once here because this codec's frames are strings. */
function encoded(value: Message): string {
    const frame = jsonCodec.encode(value);
    if (typeof frame !== 'string') throw new Error('jsonCodec produced a non-string frame');
    return frame;
}

function caught(fn: () => unknown): unknown {
    try {
        fn();
    } catch (error) {
        return error;
    }
    return undefined;
}

const encoder = new TextEncoder();

describe('jsonCodec — generated round trip', () => {
    it('round-trips every generated admissible value, byte for byte', () => {
        // The containment property over generated input: whatever `encode` emits, its own `decode`
        // accepts, and the frame is what a stock `JSON.parse` on a debugging proxy would read.
        for (let i = 0; i < 400; i++) {
            const seed = SEED + i;
            const value = admissible(gen(seed), 7, { left: 400 });
            const note = `seed ${seed}`;
            const frame = encoded(value);
            expect(frame, note).toBe(JSON.stringify(value));
            expect(jsonCodec.decode(frame), note).toEqual(JSON.parse(JSON.stringify(value)));
        }
    });

    it('round-trips a generated spine at the depth cap and refuses one past it', () => {
        // The cap is the same number on both directions, and a codec that encodes deeper than it
        // decodes mints frames its own peer refuses.
        for (let i = 0; i < 24; i++) {
            const seed = SEED + 1000 + i;
            const g = gen(seed);
            const note = `seed ${seed}`;
            const accepted = spine(g, MAX_DEPTH);
            expect(jsonCodec.decode(jsonCodec.encode(accepted)), note).toEqual(accepted);
            expect(
                caught(() => jsonCodec.encode(spine(g, MAX_DEPTH + 1))),
                note,
            ).toMatchObject({
                code: 'encode-rejected',
            });
        }
    });

    it('round-trips a frame sitting exactly on the byte cap, and refuses one byte more', () => {
        // The cap is the receiver's, and `encode` has none — so a producer can mint a frame its peer
        // refuses, which is why a producer measures with `byteLength` before it sends.
        for (let i = 0; i < 3; i++) {
            const seed = SEED + 2000 + i;
            const g = gen(seed);
            const note = `seed ${seed}`;
            const envelopeBytes = '{"a":""}'.length;

            const fits = encoded({ a: padding(g, MAX_FRAME_BYTES - envelopeBytes) });
            expect(jsonCodec.byteLength(fits), note).toBe(MAX_FRAME_BYTES);
            expect(jsonCodec.decode(fits), note).toEqual(JSON.parse(fits));

            const over = encoded({ a: padding(g, MAX_FRAME_BYTES - envelopeBytes + 1) });
            expect(jsonCodec.byteLength(over), note).toBe(MAX_FRAME_BYTES + 1);
            expect(
                caught(() => jsonCodec.decode(over)),
                note,
            ).toMatchObject({
                code: 'frame-too-large',
            });
        }
    });

    it('accepts a generated wide DAG and refuses one that expands past the node budget', () => {
        // Sharing one object across levels multiplies rather than adds, so a tiny input expands to a
        // frame no depth or byte check downstream would have caught.
        for (let i = 0; i < 8; i++) {
            const seed = SEED + 3000 + i;
            const g = gen(seed);
            const note = `seed ${seed}`;

            const leafNode = { v: 1 };
            const wide = Array.from({ length: 10_000 + g.int(20_000) }, () => leafNode);
            expect(
                caught(() => jsonCodec.encode(wide)),
                note,
            ).toBeUndefined();

            // Sized to land just past the budget rather than far past it, so a codec that lost the
            // guard fails this assertion instead of exhausting the heap and taking the run with it.
            const [branch, depth] = g.pick([
                [2, 20],
                [3, 13],
                [4, 10],
                [5, 9],
            ] as const);
            let node: Message = { v: 1 };
            for (let d = 0; d < depth; d++) {
                const parent: Record<string, Message> = {};
                for (let b = 0; b < branch; b++) parent[`c${b}`] = node;
                node = parent;
            }
            expect(
                caught(() => jsonCodec.encode(node)),
                note,
            ).toMatchObject({
                code: 'encode-rejected',
                message: expect.stringContaining('expands to more than'),
            });
        }
    });
});

/** A live engine object reaching `send` unserialized: it stringifies to a plausible non-entity. */
class Coin {
    readonly id = 'e42';
}

/**
 * Values `encode` must refuse, each planted at a generated path rather than at a fixed one.
 *
 * `names` is asserted against the message because the rejections overlap — a NaN that slips past the
 * NaN branch is still refused by the non-finite one, under text that sends the reader to the wrong
 * field.
 */
const HOSTILE: ReadonlyArray<{ what: string; names: string; make: () => unknown }> = [
    { what: 'undefined', names: 'JSON DROPS', make: () => undefined },
    { what: 'NaN', names: 'is NaN', make: () => Number.NaN },
    { what: 'Infinity', names: 'is Infinity', make: () => Number.POSITIVE_INFINITY },
    { what: '-Infinity', names: 'is -Infinity', make: () => Number.NEGATIVE_INFINITY },
    { what: 'a function', names: 'a function', make: () => () => 1 },
    { what: 'a symbol', names: 'a symbol', make: () => Symbol('s') },
    { what: 'a BigInt', names: 'a BigInt (1n)', make: () => 1n },
    { what: 'a Map', names: 'a Map instance', make: () => new Map([['a', 1]]) },
    { what: 'a Set', names: 'a Set instance', make: () => new Set([1]) },
    { what: 'a Date', names: 'a Date instance', make: () => new Date(0) },
    { what: 'a RegExp', names: 'a RegExp instance', make: () => /x/ },
    { what: 'a Uint8Array', names: 'a Uint8Array instance', make: () => new Uint8Array([1, 2]) },
    { what: 'a boxed number', names: 'a Number instance', make: () => new Number(5) },
    {
        what: 'a prototype-less object',
        names: 'a prototype-less object',
        make: () => Object.create(null) as object,
    },
    { what: 'a class instance', names: 'a Coin instance', make: () => new Coin() },
    { what: 'a toJSON method', names: 'a function', make: () => ({ toJSON: () => 42 }) },
    {
        what: 'a getter',
        names: 'is a getter',
        make: () => ({
            get boom() {
                return 1;
            },
        }),
    },
    {
        what: 'a cycle',
        names: 'circular reference',
        make: () => {
            const a: Record<string, unknown> = {};
            a.self = a;
            return a;
        },
    },
    ...[...RESERVED_KEYS].map((key) => ({
        what: `a "${key}" key`,
        names: `reserved key "${key}"`,
        // Computed rather than a literal, which for `__proto__` would set the prototype instead of
        // creating the own key `JSON.parse` produces.
        make: () => ({ [key]: 1 }),
    })),
];

/** Buries `value` under a generated chain of containers, returning the path `encode` must name. */
function plant(g: Gen, value: unknown): { readonly root: unknown; readonly path: string } {
    let root = value;
    let path = '';
    const depth = 1 + g.int(6);
    for (let i = 0; i < depth; i++) {
        if (g.chance(0.5)) {
            const index = g.int(4);
            const items: unknown[] = Array.from({ length: index }, () => 0);
            items.push(root);
            path = `[${index}]${path}`;
            root = items;
        } else {
            const key = g.pick(['a', 'hero', 'stats', 'hp']);
            path = `.${key}${path}`;
            root = { [key]: root };
        }
    }
    return { root, path };
}

describe('jsonCodec — generated encode rejections', () => {
    for (const { what, names, make } of HOSTILE) {
        it(`refuses ${what} wherever it is planted, and names it and the path`, () => {
            // The path is what the creator navigates by, and a walk that reports the frame instead of
            // the field sends them reading the whole payload.
            for (let i = 0; i < 12; i++) {
                const seed = SEED + 4000 + i;
                const { root, path } = plant(gen(seed), make());
                const error = caught(() => jsonCodec.encode(root as Message));
                expect(error, `seed ${seed}`).toBeInstanceOf(TransportError);
                expect(error, `seed ${seed}`).toMatchObject({
                    code: 'encode-rejected',
                    message: expect.stringContaining(path),
                });
                expect((error as TransportError).message, `seed ${seed}`).toContain(names);
            }
        });
    }
});

describe('jsonCodec — generated hostile frames', () => {
    it('refuses a pollution key at any generated depth or position', () => {
        // `JSON.parse` makes `__proto__` an OWN property, so it survives to whatever merges the value
        // next — and one nested under an admissible key is the frame a shallow check misses.
        for (let i = 0; i < 60; i++) {
            const seed = SEED + 5000 + i;
            const g = gen(seed);
            const key = g.pick([...RESERVED_KEYS]);
            const { root } = plant(g, { [key]: g.chance(0.5) ? 1 : { x: [1, 2] } });
            expect(
                caught(() => jsonCodec.decode(JSON.stringify(root))),
                `seed ${seed}`,
            ).toMatchObject({ code: 'pollution-key' });
        }
    });

    it('refuses a numeric literal that overflows to non-finite, at any generated position', () => {
        // Well-formed JSON that parses to a value `encode` refuses — the gap between the two
        // directions is exactly what a hostile peer probes for.
        for (let i = 0; i < 40; i++) {
            const seed = SEED + 6000 + i;
            const g = gen(seed);
            const literal = g.pick(['1e999', '-1e999', '1e400', '-2e308']);
            const { root } = plant(g, '@');
            const frame = JSON.stringify(root).replace('"@"', literal);
            expect(
                caught(() => jsonCodec.decode(frame)),
                `seed ${seed}`,
            ).toMatchObject({
                code: 'unsupported-value',
            });
            expect(
                caught(() => jsonCodec.decode(literal)),
                `seed ${seed}`,
            ).toMatchObject({
                code: 'unsupported-value',
            });
        }
    });

    it('walks a frame at the depth cap and refuses one past it, without recursing', () => {
        // A reviver would overflow here on a well-formed frame far under the byte cap, needing no
        // malformed input at all.
        for (let i = 0; i < 24; i++) {
            const seed = SEED + 7000 + i;
            const g = gen(seed);
            const note = `seed ${seed}`;
            expect(
                caught(() => jsonCodec.decode(spineFrame(g, MAX_DEPTH))),
                note,
            ).toBeUndefined();
            expect(
                caught(() => jsonCodec.decode(spineFrame(g, MAX_DEPTH + 1))),
                note,
            ).toMatchObject({ code: 'frame-too-deep' });
        }
    });

    it('refuses a generated frame over the byte cap before parsing it', () => {
        for (let i = 0; i < 3; i++) {
            const seed = SEED + 8000 + i;
            const g = gen(seed);
            const over = `{"a":"${padding(g, MAX_FRAME_BYTES + g.int(4096))}"}`;
            expect(
                caught(() => jsonCodec.decode(over)),
                `seed ${seed}`,
            ).toMatchObject({
                code: 'frame-too-large',
            });
        }
    });

    it('refuses a frame that is not a string', () => {
        for (let i = 0; i < 20; i++) {
            const seed = SEED + 9000 + i;
            const g = gen(seed);
            const bytes = Uint8Array.from({ length: g.int(64) }, () => g.int(256));
            expect(
                caught(() => jsonCodec.decode(bytes)),
                `seed ${seed}`,
            ).toMatchObject({
                code: 'malformed-frame',
            });
        }
    });
});

/** Characters a hostile peer's frame is actually made of, so junk lands near valid JSON. */
const JUNK: readonly string[] = [
    ...'{}[]",:\\/0123456789eE.+-nulltruefalse \n\t',
    '\u0000',
    '\ud800',
    '\udfff',
    '￿',
    '😀',
    'é',
    '__proto__',
];

describe('jsonCodec — decode never crashes', () => {
    it('answers arbitrary junk with a value or a TransportError, never another error type', () => {
        // Drop-and-close needs a machine-readable code; anything else escaping `decode` reaches a
        // socket event handler where nothing can catch it.
        for (let i = 0; i < 1500; i++) {
            const seed = SEED + 10_000 + i;
            const g = gen(seed);
            let frame = '';
            const length = g.int(80);
            for (let c = 0; c < length; c++) frame += g.pick(JUNK);
            const error = caught(() => jsonCodec.decode(frame));
            if (error !== undefined) expect(error, `seed ${seed}`).toBeInstanceOf(TransportError);
        }
    });

    it('answers a truncated or bit-flipped valid frame the same way', () => {
        // The interesting inputs: a frame that was valid until the wire cut it short or corrupted a
        // byte, which is the shape a parser bug hides behind.
        for (let i = 0; i < 1200; i++) {
            const seed = SEED + 20_000 + i;
            const g = gen(seed);
            const frame = encoded(admissible(g, 5, { left: 60 }));
            const damaged = g.chance(0.5)
                ? frame.slice(0, g.int(frame.length + 1))
                : bitFlip(g, frame);
            const error = caught(() => jsonCodec.decode(damaged));
            if (error !== undefined) expect(error, `seed ${seed}`).toBeInstanceOf(TransportError);
        }
    });

    it('answers an unterminated or absurdly deep frame without exhausting the stack', () => {
        // `JSON.parse` walks depth a recursive check over its result cannot, so this is where a
        // RangeError would escape as the process rather than as a closed connection.
        for (let i = 0; i < 12; i++) {
            const seed = SEED + 30_000 + i;
            const g = gen(seed);
            const depth = 10_000 + g.int(40_000);
            const opener = g.pick(['[', '{"a":']);
            const frames: readonly Frame[] = [
                opener.repeat(depth),
                spineFrame(g, depth),
                `${spineFrame(g, depth)}]`,
            ];
            for (const frame of frames) {
                expect(
                    caught(() => jsonCodec.decode(frame)),
                    `seed ${seed}`,
                ).toBeInstanceOf(TransportError);
            }
        }
    });
});

function bitFlip(g: Gen, frame: string): string {
    if (frame.length === 0) return frame;
    const index = g.int(frame.length);
    const flipped = frame.charCodeAt(index) ^ (1 << g.int(16));
    return frame.slice(0, index) + String.fromCharCode(flipped) + frame.slice(index + 1);
}

describe('jsonCodec — byteLength against the real encoding', () => {
    it('counts what the encoder would put on the wire, for generated strings of every width', () => {
        // UTF-16 `.length` undercounts every non-ASCII character, and this count is what backpressure
        // and the frame cap both read.
        for (let i = 0; i < 400; i++) {
            const seed = SEED + 40_000 + i;
            const g = gen(seed);
            let text = '';
            const length = g.int(40);
            for (let c = 0; c < length; c++) text += g.pick([...STRINGS, ...JUNK]);
            expect(jsonCodec.byteLength(text), `seed ${seed}`).toBe(encoder.encode(text).length);
            const frame = encoded({ t: text });
            expect(jsonCodec.byteLength(frame), `seed ${seed}`).toBe(encoder.encode(frame).length);
        }
    });

    it('reports a binary frame by its own byte count', () => {
        for (let i = 0; i < 20; i++) {
            const seed = SEED + 50_000 + i;
            const g = gen(seed);
            const length = g.int(256);
            const bytes = Uint8Array.from({ length }, () => g.int(256));
            expect(jsonCodec.byteLength(bytes), `seed ${seed}`).toBe(length);
        }
    });
});
