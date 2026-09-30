import { encodeHandoff } from '@grove/api-contract';
import type { PlayHandoff } from '@grove/api-contract';
import { configuredUrl } from '@grove/ui';

/** Where the player origin is, which a build is told and a dev server defaults for. */
export function playerUrl(): string {
    return configuredUrl(
        'VITE_PLAYER_URL',
        import.meta.env.VITE_PLAYER_URL,
        'http://localhost:5177',
        import.meta.env.DEV,
    );
}

/**
 * The player origin, with the join in its fragment.
 *
 * A fragment rather than a query: a browser never sends one to a server, so the ticket stays out of
 * access logs, proxy traces and `Referer`. The player origin cannot ask `@grove/api` for a join
 * itself, so this is the only way one reaches it.
 */
export function playerLink(handoff: PlayHandoff): string {
    const url = new URL('/', playerUrl());
    url.hash = encodeHandoff(handoff);
    return url.toString();
}
