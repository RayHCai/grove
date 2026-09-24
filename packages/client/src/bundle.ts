// The hash is checked BEFORE evaluation: a bundle is executable, so comparing after would mean
// running the peer's code to decide whether to run it.

import type { ScriptLocation } from '@platform/core';
import { REMOTE_ASSET_SCHEMES, isAllowedAssetUrl } from '@platform/renderer';
import { MAX_BUNDLE_BYTES } from './constants.js';
import type { ScriptClass, ScriptIndex } from './mirror.js';

/** What the project's script bundle is fetched and evaluated with. Real owner: the host app. */
export interface BundleSource {
    /** Fetches `url`, rejecting on anything but a successful response. */
    fetch(url: string): Promise<ArrayBuffer>;
    /** Lowercase-hex SHA-256 of `bytes`. */
    hash(bytes: ArrayBuffer): Promise<string>;
    /** Evaluates bytes this client has already verified — never a second fetch of the url. */
    evaluate(bytes: ArrayBuffer): Promise<unknown>;
}

/** Why a bundle did not load; the message reaches a person. Not scripting's `BundleError`. */
export class BundleLoadError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BundleLoadError';
    }
}

/**
 * One class as a side chunk carries it. Structural, so a chunk built by `@platform/scripting` fits
 * without this package importing the toolchain that built it.
 */
interface ChunkEntry {
    id: string;
    location: ScriptLocation;
    ctor: ScriptClass;
}

/** What a client chunk's module exports. The side is checked: a server chunk here is the wrong half. */
interface ChunkModule {
    side: string;
    scripts: readonly ChunkEntry[];
}

/**
 * The locations that link into a client chunk.
 *
 * `server` is absent deliberately: a `ServerScript` in the browser's half is a build that leaked
 * authority code across the seam, and attaching one here would run it on a client tick.
 */
const LOCATIONS: ReadonlySet<string> = new Set<ScriptLocation>(['client', 'synced']);

function isChunkEntry(value: unknown): value is ChunkEntry {
    if (typeof value !== 'object' || value === null) return false;
    const entry = value as Partial<ChunkEntry>;
    return (
        typeof entry.id === 'string' &&
        entry.id !== '' &&
        typeof entry.location === 'string' &&
        LOCATIONS.has(entry.location) &&
        typeof entry.ctor === 'function'
    );
}

/**
 * Narrows an evaluated module to the classes a mirror resolves an `attach` through.
 *
 * Checked rather than cast: the module is the peer's code, and an `attach` naming an id that
 * resolved to something uncallable would throw inside the frame loop rather than here.
 */
export function scriptIndexFrom(module: unknown): ScriptIndex {
    if (typeof module !== 'object' || module === null) {
        throw new BundleLoadError('the game code exported nothing this client can run');
    }
    const chunk = module as Partial<ChunkModule>;
    // A server chunk reaching a browser is a build that crossed its halves over, and running it
    // here would put `ServerScript` classes on a client tick.
    if (chunk.side !== 'client') {
        throw new BundleLoadError(
            `the game code is the ${String(chunk.side)} half, which does not run in a browser`,
        );
    }
    if (!Array.isArray(chunk.scripts)) {
        throw new BundleLoadError('the game code names no scripts');
    }

    const byId = new Map<string, ChunkEntry>();
    for (const entry of chunk.scripts) {
        if (!isChunkEntry(entry)) {
            throw new BundleLoadError('the game code names a script this client cannot read');
        }
        // Two classes under one id would make which one an `attach` resolves to depend on the
        // order a bundler happened to emit them in.
        if (byId.has(entry.id)) {
            throw new BundleLoadError(`the game code names the script "${entry.id}" twice`);
        }
        byId.set(entry.id, entry);
    }

    return {
        resolve: (id) => byId.get(id)?.ctor,
        locationOf: (id) => byId.get(id)?.location,
    };
}

/**
 * Fetches, verifies and evaluates the bundle at `url`, or throws a {@link BundleLoadError}.
 *
 * Answers the module it evaluated, because the classes in it are the whole point: a load that
 * verified the bytes and dropped what they exported would leave every `attach` resolving to
 * nothing, which is a session that joins and then renders an empty world.
 */
export async function loadBundle(
    source: BundleSource,
    url: string,
    expectedHash: string,
): Promise<ScriptIndex> {
    // Code, not data: a scheme the client did not choose is refused outright, and a refused bundle
    // fails the session — there is nothing to draw a placeholder for.
    if (!isAllowedAssetUrl(url, REMOTE_ASSET_SCHEMES)) {
        throw new BundleLoadError(
            `the game code is at an address this client will not fetch: ${url}`,
        );
    }
    if (expectedHash === '') {
        throw new BundleLoadError('the server named game code but no hash to check it against');
    }

    const bytes = await source.fetch(url);
    // Bounded before it is hashed or evaluated: the length is peer-chosen, and both the digest and
    // the parse behind it are linear in it.
    if (bytes.byteLength > MAX_BUNDLE_BYTES) {
        throw new BundleLoadError(
            `the game code is ${bytes.byteLength} bytes, past the ${MAX_BUNDLE_BYTES} this client will run`,
        );
    }

    const actual = await source.hash(bytes);
    if (actual !== expectedHash) {
        throw new BundleLoadError(
            'the game code does not match what the server said it would send — refusing to run it',
        );
    }
    return scriptIndexFrom(await source.evaluate(bytes));
}
