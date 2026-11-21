// The sender's walk, shared by the client's request payloads and the sim's `@serverState`: one
// rule for what a creator value can become on the wire, so the two cannot drift apart.

import type { JsonValue } from '@platform/transport';
import { RESERVED_KEYS } from '@platform/transport';
import { MAX_VALUE_DEPTH } from './limits.js';

/** What a class instance stands for on the wire; the sim's names `Entity`, unimportable here. */
export type WireRef = (value: object) => JsonValue | undefined;

/** A creator value as JSON, or `undefined` for one the wire cannot carry as itself, to drop. */
export function toWireValue(value: unknown, ref?: WireRef): JsonValue | undefined {
    return walk(value, ref, new Set(), 0);
}

function walk(
    value: unknown,
    ref: WireRef | undefined,
    open: Set<object>,
    depth: number,
): JsonValue | undefined {
    if (value === null) return null;
    switch (typeof value) {
        case 'number':
            return Number.isFinite(value) ? value : undefined;
        case 'string':
        case 'boolean':
            return value;
        case 'object':
            break;
        default:
            return undefined;
    }

    const plain = !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
    // A Map round-trips to `{}` and a Date to a string, so only what `ref` names may stand in.
    if (!Array.isArray(value) && !plain) return ref?.(value);

    // `open` is an ancestor set, deleted on the way out, so a DAG stays legal exactly as it is on
    // the wire while a cycle is refused before the recursion blows the stack.
    if (open.has(value) || depth >= MAX_VALUE_DEPTH) return undefined;
    open.add(value);
    try {
        if (Array.isArray(value)) {
            const items: JsonValue[] = [];
            for (const item of value as unknown[]) {
                const encoded = walk(item, ref, open, depth + 1);
                if (encoded === undefined) return undefined;
                items.push(encoded);
            }
            return items;
        }
        const out: { [key: string]: JsonValue } = {};
        for (const key of Object.keys(value)) {
            if (RESERVED_KEYS.has(key)) return undefined;
            // Read through the descriptor: a getter is creator code, and running it here would run
            // it outside any handler's boundary before anything could decline to send it.
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (descriptor === undefined || descriptor.get !== undefined) return undefined;
            const encoded = walk(descriptor.value, ref, open, depth + 1);
            if (encoded === undefined) return undefined;
            out[key] = encoded;
        }
        return out;
    } finally {
        open.delete(value);
    }
}
