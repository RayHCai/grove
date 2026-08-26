// The host app's `KVStore`: one JSON file, loaded once and rewritten on every write.
//
// Core declares the seam and ships a `MemoryKVStore` that dies with the process, which is the honest
// null implementation — but it makes "persisted" mean nothing, so the real one belongs to whoever
// hosts the game. That is this process, since `@platform/server` never opens a file any more than it
// opens a socket.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { KVStore } from '@platform/core';

/**
 * Length-prefixed, as core's memory store is, so neither half of the key can forge the other.
 *
 * The NUL is spelled out because a literal control byte is invisible to review and survives no
 * reformat — the same reason core's does.
 */
function key(scope: string, name: string): string {
    return `${scope.length}\u0000${scope}${name}`;
}

/**
 * A `KVStore` over one JSON file at `path`.
 *
 * Whole-file rather than a row per key: a playground holds a handful of players' records, and a real
 * database is the thing this is standing in for rather than competing with.
 */
export function fileKVStore(path: string): KVStore {
    /** Loaded once and then authoritative in memory — the file is the copy, not the source. */
    let loaded: Promise<Map<string, unknown>> | undefined;
    /** Writes are chained rather than raced, so two sets cannot interleave into one file. */
    let writing: Promise<void> = Promise.resolve();

    const load = (): Promise<Map<string, unknown>> => {
        loaded ??= readFile(path, 'utf8')
            .then((text) => new Map(Object.entries(JSON.parse(text) as Record<string, unknown>)))
            // A missing or unreadable file is an empty store, not a failure: the first run has none,
            // and refusing to boot over a corrupted one would take the game down with it.
            .catch(() => new Map<string, unknown>());
        return loaded;
    };

    const flush = (data: Map<string, unknown>): Promise<void> => {
        writing = writing.then(async () => {
            // Written beside the target and renamed over it, because a crash partway through a
            // direct write leaves a truncated file that parses as an empty store — silently losing
            // everything rather than failing to load.
            const temporary = `${path}.tmp`;
            await mkdir(dirname(path), { recursive: true });
            await writeFile(temporary, JSON.stringify(Object.fromEntries(data)), 'utf8');
            await rename(temporary, path);
        });
        return writing;
    };

    return {
        async get(scope: string, name: string): Promise<unknown> {
            return (await load()).get(key(scope, name));
        },
        async set(scope: string, name: string, value: unknown): Promise<void> {
            const data = await load();
            data.set(key(scope, name), value);
            await flush(data);
        },
        async delete(scope: string, name: string): Promise<void> {
            const data = await load();
            data.delete(key(scope, name));
            await flush(data);
        },
    };
}
