// The script bundle: fetched over HTTP, checked against the hash the `Welcome` named, and only then
// evaluated.
//
// The order is the whole mechanism. A bundle is executable, so a client that evaluated first and
// compared after would be running the peer's code to decide whether to run the peer's code. It is
// also why the seam below is three primitives rather than one `load(url, hash)`: the comparison
// between them belongs to this file, and a host handed the whole job could skip it silently.

import { REMOTE_ASSET_SCHEMES, isAllowedAssetUrl } from '@platform/renderer';
import { MAX_BUNDLE_BYTES } from './constants.js';

/** What the project's script bundle is fetched and evaluated with. Real owner: the host app. */
export interface BundleSource {
    /** Fetches `url`, rejecting on anything but a successful response. */
    fetch(url: string): Promise<ArrayBuffer>;
    /** Lowercase-hex SHA-256 of `bytes`. */
    hash(bytes: ArrayBuffer): Promise<string>;
    /** Evaluates bytes this client has already verified — never a second fetch of the url. */
    evaluate(bytes: ArrayBuffer): Promise<unknown>;
}

/** Why a bundle did not load. The message reaches a person, so it says what happened in words. */
export class BundleError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BundleError';
    }
}

/**
 * Fetches, verifies and evaluates the bundle at `url`, or throws a {@link BundleError}.
 *
 * `expectedHash` is the server's; a mismatch is terminal rather than a retry, because the bytes that
 * arrived are not the bytes the authority is simulating with and running them is exactly the silent
 * prediction divergence the hash exists to prevent.
 */
export async function loadBundle(
    source: BundleSource,
    url: string,
    expectedHash: string,
): Promise<void> {
    // The constraint the asset manifest's url already carries, for a worse payload: an asset entry
    // is data and this is code, so a scheme the client did not choose is refused outright. Unlike a
    // manifest row, a refused bundle fails the session — there is nothing to draw a placeholder for.
    if (!isAllowedAssetUrl(url, REMOTE_ASSET_SCHEMES)) {
        throw new BundleError(`the game code is at an address this client will not fetch: ${url}`);
    }
    if (expectedHash === '') {
        throw new BundleError('the server named game code but no hash to check it against');
    }

    const bytes = await source.fetch(url);
    // Bounded before it is hashed or evaluated: the length is peer-chosen, and both the digest and
    // the parse behind it are linear in it.
    if (bytes.byteLength > MAX_BUNDLE_BYTES) {
        throw new BundleError(
            `the game code is ${bytes.byteLength} bytes, past the ${MAX_BUNDLE_BYTES} this client will run`,
        );
    }

    const actual = await source.hash(bytes);
    if (actual !== expectedHash) {
        throw new BundleError(
            'the game code does not match what the server said it would send — refusing to run it',
        );
    }
    await source.evaluate(bytes);
}
