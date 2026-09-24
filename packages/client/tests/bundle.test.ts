// What a client will and will not run, and what it keeps of what it ran.
//
// The order — fetch, bound, hash, compare, evaluate — is asserted through a source that records
// what it was asked, because a bundle is executable and evaluating before comparing would mean
// running the peer's code to decide whether to run the peer's code.

import { describe, expect, it } from 'vitest';
import { BundleLoadError, loadBundle, scriptIndexFrom } from '../src/bundle.js';
import type { BundleSource } from '../src/bundle.js';
import { MAX_BUNDLE_BYTES } from '../src/constants.js';
import { scriptId } from '@platform/project';

const URL_OK = 'https://cdn.grove.example/b/abc.js';
const DIGEST = 'a'.repeat(64);

// Stand-ins for creator classes. A chunk carries constructors, and what they do is the game's.
class Runner {
    readonly kind = 'runner';
}
class Screen {
    readonly kind = 'screen';
}

/** A client chunk holding whatever the caller wants it to. */
function chunk(over: Record<string, unknown> = {}): unknown {
    return {
        side: 'client',
        scripts: [{ id: 'runner', location: 'synced', ctor: Runner }],
        ...over,
    };
}

interface Recorded {
    fetched: string[];
    hashed: number;
    evaluated: number;
}

function source(
    over: Partial<BundleSource> = {},
    byteLength = 8,
): { source: BundleSource; log: Recorded } {
    const log: Recorded = { fetched: [], hashed: 0, evaluated: 0 };
    return {
        log,
        source: {
            fetch: async (url) => {
                log.fetched.push(url);
                return new ArrayBuffer(byteLength);
            },
            hash: async () => {
                log.hashed += 1;
                return DIGEST;
            },
            evaluate: async () => {
                log.evaluated += 1;
                return chunk();
            },
            ...over,
        },
    };
}

describe('loading a bundle', () => {
    it('answers the classes it evaluated, which is the whole point of loading one', async () => {
        // A load that verified the bytes and dropped what they exported would leave every attach
        // resolving to nothing: a session that joins and then renders an empty world.
        const index = await loadBundle(source().source, URL_OK, DIGEST);

        expect(index.resolve(scriptId('runner'))).toBe(Runner);
        expect(index.locationOf(scriptId('runner'))).toBe('synced');
    });

    it('never evaluates bytes whose digest did not match', async () => {
        const { source: bundle, log } = source({ hash: async () => 'b'.repeat(64) });

        await expect(loadBundle(bundle, URL_OK, DIGEST)).rejects.toThrow(BundleLoadError);
        expect(log.evaluated).toBe(0);
    });

    it('refuses an address this client did not choose, before it fetches anything', async () => {
        const { source: bundle, log } = source();

        await expect(loadBundle(bundle, 'file:///etc/passwd', DIGEST)).rejects.toThrow(
            /will not fetch/u,
        );
        expect(log.fetched).toEqual([]);
    });

    it('refuses a server that named code but no hash to check it against', async () => {
        const { source: bundle, log } = source();

        await expect(loadBundle(bundle, URL_OK, '')).rejects.toThrow(/no hash/u);
        expect(log.fetched).toEqual([]);
    });

    it('bounds the bytes before it hashes them', async () => {
        // Both the digest and the parse behind it are linear in a length the peer chose.
        const { source: bundle, log } = source({}, MAX_BUNDLE_BYTES + 1);

        await expect(loadBundle(bundle, URL_OK, DIGEST)).rejects.toThrow(/past the/u);
        expect(log.hashed).toBe(0);
        expect(log.evaluated).toBe(0);
    });
});

describe('reading a chunk a client just evaluated', () => {
    it('resolves every class it names, and nothing it does not', () => {
        const index = scriptIndexFrom(
            chunk({
                scripts: [
                    { id: 'runner', location: 'synced', ctor: Runner },
                    { id: 'hud', location: 'client', ctor: Screen },
                ],
            }),
        );

        expect(index.resolve(scriptId('hud'))).toBe(Screen);
        expect(index.resolve(scriptId('absent'))).toBeUndefined();
        expect(index.locationOf(scriptId('absent'))).toBeUndefined();
    });

    it('refuses the server half, which does not run in a browser at all', () => {
        // A build that crossed its halves over. Attaching one of these would put ServerScript
        // classes on a client tick.
        expect(() => scriptIndexFrom(chunk({ side: 'server' }))).toThrow(
            /does not run in a browser/u,
        );
    });

    it('refuses a server-located class smuggled into the client half', () => {
        expect(() =>
            scriptIndexFrom(chunk({ scripts: [{ id: 'x', location: 'server', ctor: Runner }] })),
        ).toThrow(/cannot read/u);
    });

    it('refuses two classes under one id', () => {
        // Which one an attach resolved to would otherwise depend on the order a bundler emitted.
        expect(() =>
            scriptIndexFrom(
                chunk({
                    scripts: [
                        { id: 'runner', location: 'synced', ctor: Runner },
                        { id: 'runner', location: 'client', ctor: Screen },
                    ],
                }),
            ),
        ).toThrow(/twice/u);
    });

    it('refuses an entry naming something that is not a class', () => {
        expect(() =>
            scriptIndexFrom(chunk({ scripts: [{ id: 'x', location: 'client', ctor: 'Runner' }] })),
        ).toThrow(/cannot read/u);
    });

    it('refuses a module that exported nothing a client can run', () => {
        for (const exported of [null, undefined, 42, 'a module', chunk({ scripts: 'runner' })]) {
            expect(() => scriptIndexFrom(exported)).toThrow(BundleLoadError);
        }
    });
});
