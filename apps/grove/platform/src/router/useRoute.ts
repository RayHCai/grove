import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { hrefOf, parseRoute, titleOf, type Route } from './routes';

/**
 * Where the address bar is, as something React can subscribe to.
 *
 * `popstate` covers the back button and nothing else (the browser does not fire it for a push this
 * app made), so every navigation below goes through `go` and tells the subscribers itself.
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

/**
 * Names the page in the tab and, after a navigation this app made, moves focus onto it.
 *
 * A navigation in place loads nothing, so without this a screen reader announces nothing and the
 * keyboard is left on a link that belonged to the page before.
 */
export function useRouteFocus(route: Route): void {
    const shown = useRef<Route | null>(null);
    // A layout effect so it lands before every page's own effects, which is what lets a page that
    // knows a better name than its route (a game's title) have the last word.
    useLayoutEffect(() => {
        document.title = titleOf(route);
    }, [route]);
    useEffect(() => {
        // Compared rather than counted: StrictMode runs this twice for the first route, and the
        // page somebody arrived on is not a navigation.
        const previous = shown.current;
        shown.current = route;
        if (previous === null || previous === route) return;
        // A new page starts at its top, header included, the way a full load would.
        window.scrollTo(0, 0);
        const target =
            document.querySelector<HTMLElement>('main h1') ?? document.querySelector('main');
        if (target === null) return;
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
        // Without preventScroll the browser scrolls the focused element into view, which on a page
        // with no h1 (home) is `main` itself, and puts the header above the fold.
        target.focus({ preventScroll: true });
    }, [route]);
}
