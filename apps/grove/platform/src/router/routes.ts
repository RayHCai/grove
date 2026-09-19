/**
 * Every page this origin has, and the address each one sits at.
 *
 * Paths rather than a fragment, because two of these addresses are written down outside this app
 * and cannot be changed by it: `@grove/editor` sends somebody who holds nothing to `/sign-in`, and
 * the reset mail `@grove/api` sends links to `/reset-password`.
 */
export type Route =
    | { at: 'landing' }
    | { at: 'sign-in'; returnTo: string | undefined }
    | { at: 'sign-up'; returnTo: string | undefined }
    | { at: 'forgot-password' }
    | { at: 'reset-password'; token: string | undefined }
    | { at: 'games' }
    | { at: 'profile' }
    | { at: 'missing'; path: string };

/** Where the editor puts the way back when it sends somebody here to sign in. */
export const RETURN_PARAM = 'return';

/** Where the reset mail puts the key. */
export const RESET_PARAM = 'token';

// Parsing needs an origin and this module never reads the document's, so relative addresses resolve
// against a name that cannot be dialled rather than against whatever host happens to be serving.
const NOWHERE = 'http://platform.invalid';

const absent = (value: string | null): string | undefined => value ?? undefined;

/** Reads a path-and-query into the page it names; anything unrecognised is the missing page. */
export function parseRoute(href: string): Route {
    const url = new URL(href, NOWHERE);
    // A trailing slash is the same address, and treating it as another one would 404 a link
    // somebody pasted with one.
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/u, '') : url.pathname;
    const query = url.searchParams;

    switch (path) {
        case '':
        case '/':
            return { at: 'landing' };
        case '/sign-in':
            return { at: 'sign-in', returnTo: absent(query.get(RETURN_PARAM)) };
        case '/sign-up':
            return { at: 'sign-up', returnTo: absent(query.get(RETURN_PARAM)) };
        case '/forgot-password':
            return { at: 'forgot-password' };
        case '/reset-password':
            return { at: 'reset-password', token: absent(query.get(RESET_PARAM)) };
        case '/games':
            return { at: 'games' };
        case '/profile':
            return { at: 'profile' };
        default:
            return { at: 'missing', path };
    }
}

/**
 * The address a route sits at, which is what a link's `href` gets.
 *
 * The reset key is deliberately not written back into one: it arrives in an address bar and is
 * taken straight out of it, and a function that could put it back would be a way to.
 */
export function hrefOf(route: Route): string {
    switch (route.at) {
        case 'landing':
            return '/';
        case 'sign-in':
        case 'sign-up':
            return withReturn(`/${route.at}`, route.returnTo);
        case 'forgot-password':
            return '/forgot-password';
        case 'reset-password':
            return '/reset-password';
        case 'games':
            return '/games';
        case 'profile':
            return '/profile';
        default:
            return route.path;
    }
}

function withReturn(path: string, returnTo: string | undefined): string {
    if (returnTo === undefined) return path;
    return `${path}?${RETURN_PARAM}=${encodeURIComponent(returnTo)}`;
}

/** The pages that mean nothing without a session, and so send an anonymous visitor to sign in. */
export function needsSession(route: Route): boolean {
    return route.at === 'games' || route.at === 'profile';
}

/** The pages that are about not having a session yet, and so have nothing to say to a holder of one. */
export function needsAnonymity(route: Route): boolean {
    return route.at === 'sign-in' || route.at === 'sign-up';
}
