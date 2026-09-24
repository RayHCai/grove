// Encoded here, not in the codec: `encode` throws on a value it refuses, ending the session.

import type { JsonValue } from '@platform/transport';
import { RESERVED_KEYS } from '@platform/transport';
import { MAX_REQUEST_DEPTH } from './constants.js';

/** One `request()` payload as wire fields; reserved keys are dropped, as the codec refuses them. */
export function requestFields(payload: Record<string, unknown>): { [field: string]: JsonValue } {
    const fields: { [field: string]: JsonValue } = {};
    for (const field of Object.keys(payload)) {
        if (RESERVED_KEYS.has(field)) continue;
        const held = dataValue(payload, field);
        if (held === undefined) continue;
        const encoded = encodeRequestValue(held.value);
        if (encoded !== undefined) fields[field] = encoded;
    }
    return fields;
}

/**
 * The value at `key`, boxed, or `undefined` for a getter — which the codec refuses outright, so
 * reading one here would run a creator's code before anything could decline to send it.
 */
function dataValue(source: object, key: string): { value: unknown } | undefined {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined || descriptor.get !== undefined) return undefined;
    return { value: descriptor.value };
}

/** One payload value as JSON, or `undefined` for "not representable", which the caller drops. */
function encodeRequestValue(
    value: unknown,
    open: Set<object> = new Set(),
    depth = 0,
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

    // `open` is an ancestor set, deleted on the way out: a DAG stays legal, a cycle is refused.
    if (open.has(value) || depth >= MAX_REQUEST_DEPTH) return undefined;
    open.add(value);
    try {
        if (Array.isArray(value)) {
            const items: JsonValue[] = [];
            for (const item of value) {
                const encoded = encodeRequestValue(item, open, depth + 1);
                if (encoded === undefined) return undefined;
                items.push(encoded);
            }
            return items;
        }
        // A Map round-trips to `{}` and a Date to a string, so the wire delivers something else.
        if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
        const out: { [key: string]: JsonValue } = {};
        for (const key of Object.keys(value)) {
            if (RESERVED_KEYS.has(key)) return undefined;
            const held = dataValue(value, key);
            if (held === undefined) return undefined;
            const encoded = encodeRequestValue(held.value, open, depth + 1);
            if (encoded === undefined) return undefined;
            out[key] = encoded;
        }
        return out;
    } finally {
        open.delete(value);
    }
}
