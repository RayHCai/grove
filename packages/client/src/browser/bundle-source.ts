import type { BundleSource } from '../bundle.js';

/** Fetch, hash and `import()` the bytes; refuses to load when `crypto.subtle` is unavailable. */
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
            // Evaluated from the hashed bytes, never a second fetch: that would be a second answer.
            const objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
            try {
                return (await import(/* @vite-ignore */ objectUrl)) as unknown;
            } finally {
                URL.revokeObjectURL(objectUrl);
            }
        },
    };
}
