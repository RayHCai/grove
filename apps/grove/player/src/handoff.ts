import { decodeHandoff } from '@grove/api-contract';
import type { PlayHandoff } from '@grove/api-contract';

/**
 * The join, as the platform left it in this page's url.
 *
 * A fragment rather than a query: a fragment is never sent to a server, so the ticket stays out of
 * access logs, proxy traces and `Referer` on the way over. Nothing on this origin can ask
 * `@grove/api` for one (the CORS allowlist holds two origins and this is not one of them), so the
 * platform mints it behind the cookie and this page is only ever the courier.
 */
export type Handoff =
    | { outcome: 'joined'; handoff: PlayHandoff }
    /** No fragment at all: somebody opened this origin directly rather than being sent here. */
    | { outcome: 'absent' }
    /** A fragment that is not one of ours, which is a link that was edited or truncated. */
    | { outcome: 'unreadable' };

/** Reads the handoff out of a url fragment, with or without its leading `#`. */
export function readHandoff(fragment: string): Handoff {
    const encoded = fragment.startsWith('#') ? fragment.slice(1) : fragment;
    if (encoded === '') return { outcome: 'absent' };
    const handoff = decodeHandoff(encoded);
    return handoff === undefined ? { outcome: 'unreadable' } : { outcome: 'joined', handoff };
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
