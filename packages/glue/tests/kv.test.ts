// The file store's three correctness rules, each of which loses data on its own when broken.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileKVStore } from '../src/node/index.js';

const made: string[] = [];

async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'glue-kv-'));
    made.push(dir);
    return join(dir, 'nested', 'state.json');
}

afterEach(async () => {
    for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('fileKVStore', () => {
    it('round-trips a value, creating the directory on the way', async () => {
        const path = await scratch();
        const store = fileKVStore(path);

        await store.set('player', 'alice', { score: 3 });
        expect(await store.get('player', 'alice')).toEqual({ score: 3 });

        // On disk, not just in memory: a second store over the same path is a fresh process.
        expect(await fileKVStore(path).get('player', 'alice')).toEqual({ score: 3 });
    });

    it('answers undefined for a key nothing wrote', async () => {
        const store = fileKVStore(await scratch());
        expect(await store.get('player', 'nobody')).toBeUndefined();
    });

    it('keeps two scopes apart even when the halves would otherwise collide', async () => {
        const store = fileKVStore(await scratch());
        // Without the length prefix, ('ab','c') and ('a','bc') are the same key.
        await store.set('ab', 'c', 'first');
        await store.set('a', 'bc', 'second');
        expect(await store.get('ab', 'c')).toBe('first');
        expect(await store.get('a', 'bc')).toBe('second');
    });

    it('deletes', async () => {
        const path = await scratch();
        const store = fileKVStore(path);
        await store.set('player', 'alice', 1);
        await store.delete('player', 'alice');
        expect(await store.get('player', 'alice')).toBeUndefined();
        expect(await fileKVStore(path).get('player', 'alice')).toBeUndefined();
    });

    it('does not interleave two writes into one file', async () => {
        const path = await scratch();
        const store = fileKVStore(path);

        // Every write rewrites the whole file, so a raced pair can drop one another's key. Chained,
        // the last file on disk holds both.
        await Promise.all(Array.from({ length: 25 }, (_, n) => store.set('player', `p${n}`, n)));

        const back = fileKVStore(path);
        for (let n = 0; n < 25; n++) expect(await back.get('player', `p${n}`)).toBe(n);
    });

    it('reads a corrupt file as an empty store rather than refusing to boot', async () => {
        const path = await scratch();
        await fileKVStore(path).set('player', 'alice', 1);
        await writeFile(path, '{ this is not json', 'utf8');

        const store = fileKVStore(path);
        expect(await store.get('player', 'alice')).toBeUndefined();
        // And it is still writable: a bad file must not leave the game unable to save.
        await store.set('player', 'bob', 2);
        expect(await store.get('player', 'bob')).toBe(2);
    });

    it('keeps saving after a write fails, rather than freezing at the last good one', async () => {
        const path = await scratch();
        // An ordinary file where the store wants a directory, so its `mkdir` cannot succeed.
        const blocker = dirname(path);
        await writeFile(blocker, 'in the way', 'utf8');

        const store = fileKVStore(path);
        await expect(store.set('player', 'alice', 1)).rejects.toThrow();

        await rm(blocker);
        // The failure belongs to its own caller and nobody else: every later write rewrites the
        // whole map, so this one carries alice too and memory and disk agree again.
        await store.set('player', 'bob', 2);

        const back = fileKVStore(path);
        expect(await back.get('player', 'alice')).toBe(1);
        expect(await back.get('player', 'bob')).toBe(2);
    });

    it('leaves no temporary beside the target once a write settles', async () => {
        const path = await scratch();
        const store = fileKVStore(path);
        await store.set('player', 'alice', 1);

        // The temp file is renamed OVER the target rather than written in place, so a crash cannot
        // leave a truncated file that parses as an empty store — and the rename MOVES it, so
        // nothing is left beside the target afterwards.
        await expect(readFile(`${path}.tmp`, 'utf8')).rejects.toThrow(/ENOENT/);
        expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({});
    });
});
