// A `KVStore` over one JSON file — the store a host has before it has infrastructure.
//
// Core's `MemoryKVStore` dies with the process and a real deployment points `@serverState` at Redis
// or Postgres; this is the case in between, and the one with three independent ways to lose data
// when it is written by hand.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { KVStore } from '@platform/core';

/**
 * Length-prefixed, as core's memory store is, so neither half of the key can forge the other.
 *
 * The NUL is spelled out because a literal control byte is invisible to review and survives no
 * reformat.
 */
function key(scope: string, name: string): string {
    return `${scope.length}\u0000${scope}${name}`;
}

/**
 * A `KVStore` over one JSON file at `path`.
 *
 * Whole-file rather than a row per key: this is for a handful of players' records, and a real
 * database is the thing it stands in for rather than competes with.
 *
 * Three correctness rules, all easy to miss: the file is loaded ONCE and then authoritative in
 * memory; writes are CHAINED rather than raced, so two `set`s cannot interleave into one file and a
 * failed write rejects its own caller without disabling the ones queued behind it; and each write
 * lands beside the target and is RENAMED over it — a crash partway through a direct write leaves a
 * truncated file that parses as an empty store, silently losing everything rather than failing to
 * load.
 */
export function fileKVStore(path: string): KVStore {
    /** Loaded once and then authoritative in memory — the file is the copy, not the source. */
    let loaded: Promise<Map<string, unknown>> | undefined;
    let writing: Promise<void> = Promise.resolve();

    const load = (): Promise<Map<string, unknown>> => {
        loaded ??= readFile(path, 'utf8')
            .then((text) => new Map(Object.entries(JSON.parse(text) as Record<string, unknown>)))
            // A missing or unreadable file is an empty store, not a failure: the first run has none,
            // and refusing to boot over a corrupted one would take the game down with it.
            .catch(() => new Map<string, unknown>());
        return loaded;
    };

    const write = async (data: Map<string, unknown>): Promise<void> => {
        const temporary = `${path}.tmp`;
        await mkdir(dirname(path), { recursive: true });
        await writeFile(temporary, JSON.stringify(Object.fromEntries(data)), 'utf8');
        await rename(temporary, path);
    };

    const flush = (data: Map<string, unknown>): Promise<void> => {
        // Queued behind whichever way the previous write settled: the caller still observes its own
        // failure, but one bad write must not freeze the store for the life of the process.
        const run = (): Promise<void> => write(data);
        const done = writing.then(run, run);
        writing = done.catch(() => {});
        return done;
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
