// The browser's bundle source, behind the `./browser` subpath so importing the client never drags
// `fetch`, `crypto.subtle` or `Blob` into a Node test's module graph.

import type { BundleSource } from '../bundle.js';

/**
 * Fetch + SubtleCrypto + an `import()` of the bytes already hashed.
 *
 * `crypto.subtle` exists only in a secure context, so a page served over plain `http:` on anything
 * but loopback cannot verify a bundle — and this refuses to load one rather than skipping the check,
 * which is the failure mode the hash exists to prevent.
 */
export function createBrowserBundleSource(): BundleSource {
    return {
        async fetch(url: string): Promise<ArrayBuffer> {
            // `omit`, because a bundle is public code: sending a cookie to whatever address the
            // server named would make the fetch carry the player's session to it.
            const response = await globalThis.fetch(url, { credentials: 'omit' });
            if (!response.ok) {
                throw new Error(`the server answered ${response.status} for the game code`);
            }
            return response.arrayBuffer();
        },

        async hash(bytes: ArrayBuffer): Promise<string> {
            if (crypto.subtle === undefined) {
                throw new Error(
                    'this page cannot verify the game code — SubtleCrypto needs https or localhost',
                );
            }
            const digest = await crypto.subtle.digest('SHA-256', bytes);
            return [...new Uint8Array(digest)]
                .map((byte) => byte.toString(16).padStart(2, '0'))
                .join('');
        },

        async evaluate(bytes: ArrayBuffer): Promise<unknown> {
            // Evaluated from the bytes that were hashed, never by importing the url a second time: a
            // second fetch is a second answer, and the digest would then describe something else.
            const objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
            try {
                return (await import(/* @vite-ignore */ objectUrl)) as unknown;
            } finally {
                URL.revokeObjectURL(objectUrl);
            }
        },
    };
}
