import { PlayHandoff } from './allocator.js';

/**
 * The join as a url fragment carries it from the platform to the player origin.
 *
 * `base64url` of the JSON, because a fragment is percent-decoded by the browser and a raw one would
 * depend on which characters a given browser chose to escape on the way in.
 */
export function encodeHandoff(handoff: PlayHandoff): string {
    const bytes = new TextEncoder().encode(JSON.stringify(handoff));
    const binary = String.fromCodePoint(...bytes);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * Reads one back, or `undefined` for anything that is not one of ours.
 *
 * Parsed against the contract rather than cast: a fragment is an input anybody can type, and
 * everything that reads this goes on to dial a socket with it.
 */
export function decodeHandoff(encoded: string): PlayHandoff | undefined {
    let decoded: string;
    try {
        const padded = encoded.replaceAll('-', '+').replaceAll('_', '/');
        // `atob` answers one byte per character, so the utf-8 that was encoded has to be put back
        // together rather than read as latin-1.
        const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
        const bytes = Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        return undefined;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(decoded);
    } catch {
        return undefined;
    }
    const handoff = PlayHandoff.safeParse(parsed);
    return handoff.success ? handoff.data : undefined;
}
