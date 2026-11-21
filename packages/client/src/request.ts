// Encoded here, not in the codec: `encode` throws on a value it refuses, ending the session.

import { toWireValue } from '@platform/protocol';
import type { JsonValue } from '@platform/transport';
import { RESERVED_KEYS } from '@platform/transport';

/** One `request()` payload as wire fields; reserved keys are dropped, as the codec refuses them. */
export function requestFields(payload: Record<string, unknown>): { [field: string]: JsonValue } {
    const fields: { [field: string]: JsonValue } = {};
    for (const field of Object.keys(payload)) {
        if (RESERVED_KEYS.has(field)) continue;
        const held = dataValue(payload, field);
        if (held === undefined) continue;
        const encoded = toWireValue(held.value);
        if (encoded !== undefined) fields[field] = encoded;
    }
    return fields;
}

/**
 * The value at `key`, boxed, or `undefined` for a getter, which the codec refuses outright, so
 * reading one here would run a creator's code before anything could decline to send it.
 */
function dataValue(source: object, key: string): { value: unknown } | undefined {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined || descriptor.get !== undefined) return undefined;
    return { value: descriptor.value };
}
