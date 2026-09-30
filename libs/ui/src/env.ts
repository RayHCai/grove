/**
 * An address a build is told through a `VITE_*` variable.
 *
 * A dev server falls back to where the local stack listens. A production build that was never told
 * throws instead, because a silent localhost there is an app dialling its visitor's own machine.
 */
export function configuredUrl(
    name: string,
    value: unknown,
    devDefault: string,
    dev: boolean,
): string {
    if (typeof value === 'string' && value !== '') return value;
    if (dev) return devDefault;
    throw new Error(`${name} is not set, and a production build has no address to fall back on`);
}

/** Where `@grove/api` is: what the build was told in `VITE_API_URL`, or the local stack's in dev. */
export function apiUrl(value: unknown, dev: boolean): string {
    return configuredUrl('VITE_API_URL', value, 'http://localhost:4000', dev);
}

/** Leaves this page for another address; what every app's injectable `navigate` falls back to. */
export function leaveFor(url: string): void {
    globalThis.location.assign(url);
}
