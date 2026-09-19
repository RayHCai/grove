import { useMemo, useSyncExternalStore } from 'react';
import { hrefOf, parseRoute, type Route } from './routes';

/**
 * Where the address bar is, as something React can subscribe to.
 *
 * `popstate` covers the back button and nothing else — the browser does not fire it for a push this
 * app made — so every navigation below goes through `go` and tells the subscribers itself.
 */
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
    listeners.add(onChange);
    window.addEventListener('popstate', onChange);
    return () => {
        listeners.delete(onChange);
        window.removeEventListener('popstate', onChange);
    };
}

function announce(): void {
    for (const listener of listeners) listener();
}

// The snapshot is the string rather than the parsed route: `useSyncExternalStore` compares by
// identity, and a fresh object every call is a render loop.
function currentHref(): string {
    return `${window.location.pathname}${window.location.search}`;
}

/** Goes to a route, leaving the one it left in the history for the back button. */
export function go(route: Route): void {
    window.history.pushState(null, '', hrefOf(route));
    announce();
}

/**
 * Goes to a route, replacing the address this page was opened with.
 *
 * What a redirect uses: a visitor bounced off a page they could not see should not have to click
 * back twice to get past it.
 */
export function replace(route: Route): void {
    window.history.replaceState(null, '', hrefOf(route));
    announce();
}

/** The page the address bar names, re-read whenever it changes. */
export function useRoute(): Route {
    const href = useSyncExternalStore(subscribe, currentHref);
    return useMemo(() => parseRoute(href), [href]);
}
