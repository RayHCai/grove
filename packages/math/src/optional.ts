/**
 * A copy of `o` without its `undefined`-valued keys, for spreading into an options object.
 * `exactOptionalPropertyTypes` rejects an explicit `undefined`, so the key must be dropped.
 */
export function defined<T extends object>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(o)) {
        if (value !== undefined) kept[key] = value;
    }
    return kept as { [K in keyof T]?: Exclude<T[K], undefined> };
}
