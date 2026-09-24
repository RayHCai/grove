import { PlayHandoff } from '@grove/api-contract';

/**
 * The join, as the platform left it in this page's url.
 *
 * A fragment rather than a query: a fragment is never sent to a server, so the ticket stays out of
 * access logs, proxy traces and `Referer` on the way over. Nothing on this origin can ask
 * `@grove/api` for one — the CORS allowlist holds two origins and this is not one of them — so the
 * platform mints it behind the cookie and this page is only ever the courier.
 */
export type Handoff =
    | { outcome: 'joined'; handoff: PlayHandoff }
    /** No fragment at all: somebody opened this origin directly rather than being sent here. */
    | { outcome: 'absent' }
    /** A fragment that is not one of ours, which is a link that was edited or truncated. */
    | { outcome: 'unreadable' };

/**
 * Reads the handoff out of a url fragment.
 *
 * `base64url` of the JSON, because a fragment is percent-decoded by the browser and a raw one
 * would depend on which characters a given browser chose to escape on the way in.
 */
export function readHandoff(fragment: string): Handoff {
    const encoded = fragment.startsWith('#') ? fragment.slice(1) : fragment;
    if (encoded === '') return { outcome: 'absent' };

    let decoded: string;
    try {
        decoded = decodeBase64Url(encoded);
    } catch {
        return { outcome: 'unreadable' };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(decoded);
    } catch {
        return { outcome: 'unreadable' };
    }

    // Parsed against the contract rather than cast: everything below this reaches a socket and a
    // renderer, and a fragment is the one input on this page anybody can type.
    const handoff = PlayHandoff.safeParse(parsed);
    return handoff.success
        ? { outcome: 'joined', handoff: handoff.data }
        : { outcome: 'unreadable' };
}

/** Writes one, which is what the platform does before it sends a browser here. */
export function encodeHandoff(handoff: PlayHandoff): string {
    return encodeBase64Url(JSON.stringify(handoff));
}

/**
 * Takes the handoff back out of the address bar.
 *
 * A ticket lives sixty seconds and is spent at the upgrade, so what this removes is mostly a
 * reload hazard: the fragment would survive one, and a second dial with a spent ticket fails in a
 * way that reads as the game being broken rather than as a link that has been used.
 */
export function clearFragment(
    location: { pathname: string; search: string },
    history: History,
): void {
    history.replaceState(null, '', `${location.pathname}${location.search}`);
}

function decodeBase64Url(value: string): string {
    const padded = value.replaceAll('-', '+').replaceAll('_', '/');
    // `atob` answers one byte per character, so the utf-8 the platform encoded has to be put back
    // together rather than read as latin-1 — a display name with an accent in it is the usual case.
    const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
    const bytes = Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
    return new TextDecoder().decode(bytes);
}

function encodeBase64Url(value: string): string {
    const bytes = new TextEncoder().encode(value);
    const binary = String.fromCodePoint(...bytes);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
