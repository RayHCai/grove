// Validation lives in the codec rather than the transport because the admissible set is the codec's
// own, so swapping the injected codec swaps the validator with it.

import type { EncodedFrame, Frame, Message } from './transport.js';
import { transportError } from './errors.js';

/**
 * The wire codec, injected at the composition root and uniform across a process's connections.
 * Every implementation must pass the shared conformance suite before it may be injected.
 */
export interface Codec {
    /** Validate against this codec's admissible set, then encode. */
    encode(message: Message): EncodedFrame;
    /** Decode, rejecting a malformed frame and pollution keys before an endpoint sees the value. */
    decode(frame: Frame): Message;
    /** Wire byte count — UTF-8 for JSON, not a string's UTF-16 `.length`; only the codec knows. */
    byteLength(frame: Frame): number;
}

/**
 * Nesting depth refused on both directions: `JSON.parse` handles hundreds of thousands of levels
 * while a walk over its result is heap-bounded, and the gap between them is exploitable.
 */
const MAX_DEPTH = 128;

/**
 * Byte ceiling on a frame this codec will decode, checked before it is parsed.
 * `MAX_DEPTH` bounds nesting; `JSON.parse` allocates a graph several times the wire bytes.
 */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * Object keys no message may carry, because they poison a downstream recursive merge.
 * Rejected rather than stripped, and on ENCODE too, so a frame this codec makes it accepts.
 */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
    '__proto__',
    'constructor',
    'prototype',
]);

/**
 * How many values one message may expand to, since MAX_DEPTH bounds the ancestor chain and not the
 * work: 23 objects sharing a child at each of 22 levels expand to a 75 MB frame from a tiny input.
 */
const MAX_NODES = 1_000_000;

/** Where in the message a rejection happened, so a throw names the field, not the frame. */
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
 * Where a child sits, as `at` wants it — built on demand, since every caller but a throw arm and a
 * container push discards it, and a healthy encode walks thousands of leaves without throwing once.
 */
function leafPath(frame: Pending | null, key: string): string {
    if (frame === null) return '';
    return Array.isArray(frame.source) ? `${frame.path}[${key}]` : `${frame.path}.${key}`;
}

/**
 * Validates a leaf against the JSON wire's admissible set; `undefined` means "recurse".
 * Takes the parent frame and key, so the path string costs nothing until a rejection.
 */
function admitLeaf(
    value: unknown,
    frame: Pending | null,
    key: string,
): { leaf: JsonLike } | undefined {
    switch (typeof value) {
        case 'string':
        case 'boolean':
            return { leaf: value };

        case 'number':
            if (Number.isNaN(value)) {
                transportError(
                    'encode-rejected',
                    `${at(leafPath(frame, key))} is NaN, which JSON silently encodes as null — send a null, a sentinel, or omit the field.`,
                );
            }
            if (!Number.isFinite(value)) {
                transportError(
                    'encode-rejected',
                    `${at(leafPath(frame, key))} is ${value > 0 ? 'Infinity' : '-Infinity'}, which JSON silently encodes as null.`,
                );
            }
            // Normalized rather than rejected: -0 falls out of ordinary arithmetic, such as a
            // velocity decelerating through zero, so rejecting would throw on real game data.
            return { leaf: Object.is(value, -0) ? 0 : value };

        case 'undefined':
            transportError(
                'encode-rejected',
                `${at(leafPath(frame, key))} is undefined, which JSON DROPS — the peer would receive a frame with the key missing. Send null if the absence is meaningful.`,
            );

        case 'function':
        case 'symbol':
        case 'bigint':
            transportError(
                'encode-rejected',
                `${at(leafPath(frame, key))} is ${describe(value)}, which cannot cross a wire. Payloads are plain values only; encode entity and player references to their ids before sending.`,
            );

        case 'object':
            break;

        /* c8 ignore next 2 -- no other typeof exists */
        default:
            transportError(
                'encode-rejected',
                `${at(leafPath(frame, key))} has unsupported type ${typeof value}.`,
            );
    }

    if (value === null) return { leaf: null };

    // Rejected rather than flattened: each of these round-trips to something OTHER than itself — a
    // Map to `{}`, a Date to a string — and a structured-clone worker wire would carry several of
    // them faithfully, so rejecting keeps the local run conservative against every wire.
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
        transportError(
            'encode-rejected',
            `${at(leafPath(frame, key))} is ${describe(value)}; the wire would deliver something other than what was sent. Send a plain object of plain values.`,
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
 * ITERATIVE: a payload nesting thousands deep would overflow while passing any byte cap.
 */
function admit(root: unknown): JsonLike {
    const rootLeaf = admitLeaf(root, null, '');
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
            if (RESERVED_KEYS.has(key)) {
                transportError(
                    'encode-rejected',
                    `${at(leafPath(frame, key))} uses the reserved key "${key}", which a decoder must refuse because it poisons any recursive merge downstream — and an own "__proto__" key would not even survive the copy. Rename the field.`,
                );
            }

            const descriptor = Object.getOwnPropertyDescriptor(frame.source, key);
            if (descriptor?.get !== undefined) {
                transportError(
                    'encode-rejected',
                    `${at(leafPath(frame, key))} is a getter; a wire carries data, not computation, and invoking it could throw or mutate mid-encode.`,
                );
            }
        }

        const value = (frame.source as Record<string, unknown>)[key];
        const leaf = admitLeaf(value, frame, key);
        if (leaf !== undefined) {
            setChild(frame, key, leaf.leaf);
            continue;
        }

        const child = value as object;
        if (open.has(child)) {
            transportError(
                'encode-rejected',
                `${at(leafPath(frame, key))} is a circular reference, which JSON cannot encode.`,
            );
        }
        if (stack.length >= MAX_DEPTH) {
            transportError(
                'encode-rejected',
                `${at(leafPath(frame, key))} nests deeper than ${MAX_DEPTH} levels, past what a wire decoder will walk. Flatten the payload.`,
            );
        }

        const copy: JsonLike[] | Record<string, JsonLike> = Array.isArray(child) ? [] : {};
        setChild(frame, key, copy);
        open.add(child);
        // The one path string an encode still builds eagerly: a container's own path is the prefix
        // every descendant's would be built from, so it cannot wait for a throw that may never
        // come.
        stack.push({
            source: child,
            copy,
            keys: keysOf(child),
            path: leafPath(frame, key),
            index: 0,
        });
    }

    return rootCopy;
}

/**
 * Own enumerable string keys, which is what `JSON.stringify` serializes; a symbol key is rejected
 * only as a VALUE. Array indices come from `length`, so holes are visited and normalized.
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
 * Rejects a decoded frame with a pollution key, a value `encode` would refuse, or over-nesting.
 * NOT a `JSON.parse` reviver: the parser calls one recursively and overflows near 5,000 levels.
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
            if (!isArray && RESERVED_KEYS.has(key)) {
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
 * Counts UTF-8 bytes without `Buffer` or a `TextEncoder`, since `src` declares no `node` types.
 * An unpaired surrogate counts as 3, matching the U+FFFD substitution a real socket would send.
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
        // The one place a frame is minted: `encode` is by definition the authority the brand
        // denotes.
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
                `Frame is ${bytes} bytes, over the ${MAX_FRAME_BYTES}-byte decode cap.`,
            );
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(frame);
        } catch (cause) {
            // Chained, not swallowed: the parser's own message names the byte offset, and a
            // consumer debugging a mismatched peer needs it.
            transportError(
                'malformed-frame',
                `Frame is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
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
