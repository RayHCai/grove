/** Where the platform is, so somebody with no session has somewhere to be sent. */
export function platformUrl(): string {
    return import.meta.env.VITE_PLATFORM_URL ?? 'http://localhost:5175';
}

/**
 * The platform's sign-in, and the way back to this editor once it has one.
 *
 * The way back is this page's own address. Nothing of the session travels on it — signing in writes
 * a cookie the browser then carries here by itself — so this URL is a destination and not a
 * credential.
 */
export function signInUrl(here: URL): string {
    const back = new URL(here.toString());
    return `${platformUrl()}/sign-in?return=${encodeURIComponent(back.toString())}`;
}
