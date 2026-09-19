// The hash is checked BEFORE evaluation: a bundle is executable, so comparing after would mean
// running the peer's code to decide whether to run it.

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

/** Why a bundle did not load; the message reaches a person. Not scripting's `BundleError`. */
export class BundleLoadError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BundleLoadError';
    }
}

/** Fetches, verifies and evaluates the bundle at `url`, or throws a {@link BundleLoadError}. */
export async function loadBundle(
    source: BundleSource,
    url: string,
    expectedHash: string,
): Promise<void> {
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
    await source.evaluate(bytes);
}
