// Validate-then-encode in one direction, reject-then-decode in the other.
//
// A bare `JSON.parse(JSON.stringify(m))` is not enough: stringify DROPS `undefined`, functions and
// symbols and turns `NaN`/`Infinity` into `null`, silently, so a frame carrying `{ t: NaN }` would
// arrive changed while a binary codec carried it faithfully — the fidelity device would become a
// source of the divergence it exists to prevent.
//
// Validation lives in the codec rather than the transport because the admissible set is the codec's
// own, so swapping the injected codec swaps the validator with it.

import type { EncodedFrame, Frame, Message } from './transport.js';
import { transportError } from './errors.js';

/**
 * The wire codec, injected at the composition root and uniform across a process's connections.
 *
 * Every implementation must pass the shared conformance suite before it may be injected.
 */
export interface Codec {
    /** Validate against this codec's admissible set, then encode. */
    encode(message: Message): EncodedFrame;
    /** Decode, rejecting a malformed frame and pollution keys before any endpoint sees the value. */
    decode(frame: Frame): Message;
    /** Wire byte count — UTF-8 for JSON, not a string's UTF-16 `.length`, since only the codec knows. */
    byteLength(frame: Frame): number;
}

/**
 * Nesting depth beyond which a frame is refused, on both directions.
 *
 * The two directions have different natural limits and the gap is exploitable: `JSON.parse` handles
 * depth in the hundreds of thousands while any walk over its result is bounded by heap, so a frame
 * nesting a few thousand deep is well-formed, a few tens of KB, under any byte cap, and used to be
 * enough to exhaust the stack. 128 is far above any envelope — a state diff is entity → component →
 * field — and far below where either walk strains.
 */
const MAX_DEPTH = 128;

/**
 * Byte ceiling on a frame this codec will decode, checked before it is parsed.
 *
 * MAX_DEPTH bounds nesting and this bounds size; neither implies the other, and a peer chooses both.
 * `JSON.parse` allocates a graph several times the wire bytes, so an unbounded frame is an
 * unbounded allocation no depth or cardinality check downstream can undo — the parse has already
 * happened by the time anything else looks.
 *
 * 4 MiB is far above any envelope on this wire: the largest is a join snapshot, and a world big
 * enough to exceed this has a scaling problem a cap is the wrong place to discover. It is a
 * conservative default rather than a tuned one, and it is the codec's because only the codec knows
 * how its bytes relate to the value.
 */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * Keys that poison a downstream recursive merge.
 *
 * `JSON.parse` creates an OWN `__proto__` key rather than walking the prototype chain, so the value
 * survives to whatever merges it next. Rejected on decode, never stripped: deleting a key would
 * alter the frame, which is the silent-transform failure in miniature.
 *
 * Rejected on ENCODE too, and that symmetry is the point — otherwise a frame this codec produced is
 * one its own `decode` refuses, and the peer blames a hostile sender for a field a creator named.
 */
const POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * How many values one message may expand to.
 *
 * MAX_DEPTH bounds the ancestor chain, not the work: the copy is made per REFERENCE, so a graph
 * sharing one object between two fields at each level doubles per level, and 23 objects nested 22
 * deep expand to a 75 MB frame while 27 exhaust a 4 GB heap — all of it far inside the depth cap and
 * far under any byte cap, because the INPUT is tiny. Counting emitted values is what turns that from
 * an out-of-memory kill into a named rejection.
 *
 * A million is roughly a megabyte of frame and two orders of magnitude above the largest payload the
 * suite builds, so it bounds the blowup without tripping on real traffic.
 */
const MAX_NODES = 1_000_000;

/** Where in the message a rejection happened, so the throw names the field rather than the frame. */
function at(path: string): string {
    return path === '' ? 'the message root' : path;
}

function describe(value: unknown): string {
    if (value === null) return 'null';
    if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value);
    if (typeof value === 'function') return 'a function';
    if (typeof value === 'symbol') return 'a symbol';
    if (typeof value === 'bigint') return `a BigInt (${String(value)}n)`;
    if (typeof value !== 'object') return typeof value;
    const proto = Object.getPrototypeOf(value) as object | null;
    if (Array.isArray(value)) return 'an array';
    if (proto === null) return 'a prototype-less object';
    const name = (proto as { constructor?: { name?: string } }).constructor?.name;
    return name === undefined || name === 'Object' ? 'a non-plain object' : `a ${name} instance`;
}

/**
 * Validates a leaf against the JSON wire's admissible set; `undefined` means "not a leaf, recurse".
 */
function admitLeaf(value: unknown, path: string): { leaf: JsonLike } | undefined {
    switch (typeof value) {
        case 'string':
        case 'boolean':
            return { leaf: value };

        case 'number':
            if (Number.isNaN(value)) {
                transportError(
                    'encode-rejected',
                    `${at(path)} is NaN, which JSON silently encodes as null — send a null, a sentinel, or omit the field.`,
                );
            }
            if (!Number.isFinite(value)) {
                transportError(
                    'encode-rejected',
                    `${at(path)} is ${value > 0 ? 'Infinity' : '-Infinity'}, which JSON silently encodes as null.`,
                );
            }
            // Normalized rather than rejected: -0 falls out of ordinary arithmetic, such as a
            // velocity decelerating through zero, so rejecting would throw on real game data.
            return { leaf: Object.is(value, -0) ? 0 : value };

        case 'undefined':
            transportError(
                'encode-rejected',
                `${at(path)} is undefined, which JSON DROPS — the peer would receive a frame with the key missing. Send null if the absence is meaningful.`,
            );

        case 'function':
        case 'symbol':
        case 'bigint':
            transportError(
                'encode-rejected',
                `${at(path)} is ${describe(value)}, which cannot cross a wire. Payloads are plain values only; encode entity and player references to their ids before sending.`,
            );

        case 'object':
            break;

        /* c8 ignore next 2 -- no other typeof exists */
        default:
            transportError('encode-rejected', `${at(path)} has unsupported type ${typeof value}.`);
    }

    if (value === null) return { leaf: null };

    // Rejected rather than flattened: each of these round-trips to something OTHER than itself — a
    // Map to `{}`, a Date to a string — and a structured-clone worker wire would carry several of
    // them faithfully, so rejecting keeps the local run conservative against every wire.
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
        transportError(
            'encode-rejected',
            `${at(path)} is ${describe(value)}; the wire would deliver something other than what was sent. Send a plain object of plain values.`,
        );
    }
    return undefined;
}

/** A container part-way through the walk: its copy, and the keys still to be filled in. */
interface Pending {
    readonly source: object;
    readonly copy: JsonLike[] | Record<string, JsonLike>;
    readonly keys: readonly string[];
    readonly path: string;
    index: number;
}

/**
 * Validates against the JSON wire's admissible set and returns a copy.
 *
 * Not a `stringify` replacer, which cannot see a dropped `undefined` in an object — the key simply
 * vanishes — and cannot distinguish a cycle from depth.
 *
 * ITERATIVE, with the container chain in `stack` rather than on the call stack: a hostile or merely
 * generated payload nesting a few thousand deep would otherwise overflow while still being
 * well-formed and small enough to pass any byte cap.
 *
 * The ancestor set is the chain currently on `stack`, not every visited node, so a DAG is legal and
 * arrives as two independent copies exactly as a socket would deliver it; only a true cycle throws.
 */
function admit(root: unknown): JsonLike {
    const rootLeaf = admitLeaf(root, '');
    if (rootLeaf !== undefined) return rootLeaf.leaf;

    const rootSource = root as object;
    const rootCopy: JsonLike[] | Record<string, JsonLike> = Array.isArray(rootSource) ? [] : {};
    const stack: Pending[] = [
        { source: rootSource, copy: rootCopy, keys: keysOf(rootSource), path: '', index: 0 },
    ];
    // A Set so the cycle check stays O(1) per node rather than a walk back up the stack per value.
    const open = new Set<object>([rootSource]);
    let nodes = 0;

    while (stack.length > 0) {
        const frame = stack[stack.length - 1] as Pending;

        if (frame.index >= frame.keys.length) {
            open.delete(frame.source);
            stack.pop();
            continue;
        }

        const key = frame.keys[frame.index] as string;
        frame.index++;

        const isArray = Array.isArray(frame.source);
        const path = isArray ? `${frame.path}[${key}]` : `${frame.path}.${key}`;

        nodes++;
        if (nodes > MAX_NODES) {
            transportError(
                'encode-rejected',
                `the message expands to more than ${MAX_NODES} values. An object referenced from several places is copied once per reference, exactly as a wire would deliver it, so sharing one object across a few levels multiplies rather than adds. Send ids instead of repeating the object.`,
            );
        }

        if (isArray && !(key in frame.source)) {
            // A hole stringifies to null but reads as undefined, so admitLeaf would reject an array
            // that is legal on the wire. Normalize instead.
            (frame.copy as JsonLike[])[Number(key)] = null;
            continue;
        }

        if (!isArray) {
            // Array indices are exempt: a key is only dangerous where it can name a prototype slot.
            if (POLLUTION_KEYS.has(key)) {
                transportError(
                    'encode-rejected',
                    `${at(path)} uses the reserved key "${key}", which a decoder must refuse because it poisons any recursive merge downstream — and an own "__proto__" key would not even survive the copy. Rename the field.`,
                );
            }

            const descriptor = Object.getOwnPropertyDescriptor(frame.source, key);
            if (descriptor?.get !== undefined) {
                transportError(
                    'encode-rejected',
                    `${at(path)} is a getter; a wire carries data, not computation, and invoking it could throw or mutate mid-encode.`,
                );
            }
        }

        const value = (frame.source as Record<string, unknown>)[key];
        const leaf = admitLeaf(value, path);
        if (leaf !== undefined) {
            setChild(frame, key, leaf.leaf);
            continue;
        }

        const child = value as object;
        if (open.has(child)) {
            transportError(
                'encode-rejected',
                `${at(path)} is a circular reference, which JSON cannot encode.`,
            );
        }
        if (stack.length >= MAX_DEPTH) {
            transportError(
                'encode-rejected',
                `${at(path)} nests deeper than ${MAX_DEPTH} levels, past what a wire decoder will walk. Flatten the payload.`,
            );
        }

        const copy: JsonLike[] | Record<string, JsonLike> = Array.isArray(child) ? [] : {};
        setChild(frame, key, copy);
        open.add(child);
        stack.push({ source: child, copy, keys: keysOf(child), path, index: 0 });
    }

    return rootCopy;
}

/**
 * Own enumerable string keys, which is what `JSON.stringify` serializes — a symbol key is skipped
 * silently by stringify, so it is rejected only when it appears as a VALUE. Array indices come from
 * `length` rather than `Object.keys` so holes are visited and normalized.
 */
function keysOf(container: object): readonly string[] {
    if (!Array.isArray(container)) return Object.keys(container);
    const keys: string[] = [];
    for (let i = 0; i < container.length; i++) keys.push(String(i));
    return keys;
}

function setChild(frame: Pending, key: string, value: JsonLike): void {
    if (Array.isArray(frame.copy)) frame.copy[Number(key)] = value;
    else frame.copy[key] = value;
}

/** The shape `admit` returns — validated, so `JSON.stringify` cannot transform it. */
type JsonLike = null | boolean | number | string | JsonLike[] | { [key: string]: JsonLike };

/**
 * Rejects a decoded frame carrying a pollution key, a value `encode` would have refused, or nesting
 * past MAX_DEPTH.
 *
 * ITERATIVE, and deliberately NOT a `JSON.parse` reviver: a reviver is the more elegant shape, but
 * the parser calls it recursively and that recursion overflows around 5,000 levels while
 * `JSON.parse` alone handles hundreds of thousands — a well-formed ~60 KB frame under any byte cap
 * could kill the process on the untrusted path, needing no malformed input at all.
 *
 * Rejecting after the parse rather than during it is safe: `JSON.parse` creates `__proto__` as an
 * OWN data property, so a parsed-but-rejected frame has poisoned nothing — the hazard is a
 * downstream recursive merge, and there is no downstream when this throws.
 */
function admitDecoded(root: unknown): void {
    if (typeof root === 'number' && !Number.isFinite(root)) {
        transportError(
            'unsupported-value',
            'Frame is a non-finite number (a numeric literal that overflows float64).',
        );
    }
    if (root === null || typeof root !== 'object') return;

    const stack: Array<{ node: object; depth: number }> = [{ node: root, depth: 1 }];
    while (stack.length > 0) {
        const { node, depth } = stack.pop() as { node: object; depth: number };
        if (depth > MAX_DEPTH) {
            transportError(
                'frame-too-deep',
                `Frame nests deeper than ${MAX_DEPTH} levels. Well-formed, but a walk over it is unbounded work on an untrusted path, so it is refused with the frame intact.`,
            );
        }

        const isArray = Array.isArray(node);
        // `__proto__` is among these, which is the point: `JSON.parse` made it an own property.
        for (const key of Object.keys(node)) {
            if (!isArray && POLLUTION_KEYS.has(key)) {
                transportError(
                    'pollution-key',
                    `Frame carries a "${key}" key, which poisons any recursive merge downstream. Rejected, not stripped — a frame carrying it IS a malformed frame.`,
                );
            }
            const value = (node as Record<string, unknown>)[key];
            // `1e999` is well-formed JSON that parses to Infinity, a value encode refuses; without
            // this a hostile peer could inject one through the gap between the two directions.
            if (typeof value === 'number' && !Number.isFinite(value)) {
                transportError(
                    'unsupported-value',
                    `Frame carries a non-finite number at "${key}" (a numeric literal that overflows float64).`,
                );
            }
            if (value !== null && typeof value === 'object') {
                stack.push({ node: value, depth: depth + 1 });
            }
        }
    }
}

/**
 * Counts UTF-8 bytes without `Buffer` or a `TextEncoder` allocation, since `src` declares no `node`
 * types and this is on the per-frame path backpressure reads.
 *
 * An unpaired surrogate counts as 3, matching what `TextEncoder` and `Buffer.byteLength` do when
 * they substitute U+FFFD, so the count is what a real socket would put on the wire.
 */
function utf8ByteLength(text: string): number {
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code < 0x80) {
            bytes += 1;
        } else if (code < 0x800) {
            bytes += 2;
        } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
            const next = text.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                bytes += 4;
                i++;
            } else {
                bytes += 3;
            }
        } else {
            bytes += 3;
        }
    }
    return bytes;
}

/** The default codec: JSON, string frames, UTF-8 byte length. */
export const jsonCodec: Codec = {
    encode(message: Message): EncodedFrame {
        // The one place a frame is minted: `encode` is by definition the authority the brand denotes.
        return JSON.stringify(admit(message)) as EncodedFrame;
    },

    decode(frame: Frame): Message {
        if (typeof frame !== 'string') {
            transportError(
                'malformed-frame',
                `jsonCodec decodes string frames; received ${describe(frame)}. A binary frame means the peer is running a different codec, which one codec per process rules out.`,
            );
        }
        // Before the parse, not after: the parse is what allocates, so a check on the result would
        // already have paid for the frame it rejects.
        const bytes = utf8ByteLength(frame);
        if (bytes > MAX_FRAME_BYTES) {
            transportError(
                'frame-too-large',
                `Frame is ${bytes} bytes, over the ${MAX_FRAME_BYTES}-byte decode cap. Refused before parsing, because parsing is what allocates.`,
            );
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(frame);
        } catch (cause) {
            // Chained, not swallowed: the parser's own message names the byte offset, and a consumer
            // debugging a mismatched peer needs it.
            transportError(
                'malformed-frame',
                `Frame is not valid JSON: ${(cause as Error).message}`,
                { cause },
            );
        }
        admitDecoded(parsed);
        return parsed as Message;
    },

    byteLength(frame: Frame): number {
        return typeof frame === 'string' ? utf8ByteLength(frame) : frame.byteLength;
    },
};
