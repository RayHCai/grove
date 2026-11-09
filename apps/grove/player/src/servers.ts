/** Which sockets this page will dial: a link is anybody's to write, and its server picks the code. */
export interface ServerPolicy {
    /** Host suffixes a server must sit under, matched at a label boundary; `undefined` is any host. */
    hosts: readonly string[] | undefined;
    /** Whether `ws:` is dialled beside `wss:`, which only a dev server's local fleet needs. */
    insecure: boolean;
}

/** `VITE_GAME_HOSTS` as a list: comma-separated, each entry a hostname its servers sit at or under. */
export function gameHosts(value: unknown): string[] | undefined {
    if (typeof value !== 'string') return undefined;
    const hosts = value
        .split(',')
        .map((entry) => entry.trim().replace(/^\*?\.+/u, ''))
        .filter((entry) => entry !== '')
        .map(hostnameOf);
    return hosts.length === 0 ? undefined : hosts;
}

/** The policy a build was told; a dev server's fleet is on this machine, so it dials anything. */
export function serverPolicy(value: unknown, dev: boolean): ServerPolicy {
    const hosts = gameHosts(value);
    // Dialling whatever a link names is what the policy exists to stop, so no fleet is no default.
    if (hosts === undefined && !dev) {
        throw new Error('VITE_GAME_HOSTS is not set, and a production build has no fleet to trust');
    }
    return { hosts, insecure: dev };
}

/** Whether a join's server is one this page may dial. */
export function trustedServer(serverUrl: string, policy: ServerPolicy): boolean {
    let url: URL;
    try {
        url = new URL(serverUrl);
    } catch {
        return false;
    }
    if (url.protocol !== 'wss:' && !(policy.insecure && url.protocol === 'ws:')) return false;
    // A credential in a socket address is one this page would be handing to whoever wrote the link.
    if (url.username !== '' || url.password !== '') return false;
    if (policy.hosts === undefined) return true;
    const host = url.hostname.replace(/\.$/u, '');
    return policy.hosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** The CSP sources for those same sockets, any port, so the policy and the check cannot disagree. */
export function socketSources(hosts: readonly string[] | undefined): string[] {
    return (hosts ?? []).flatMap((host) => {
        // A CSP host has no spelling for an IPv6 literal, and an IPv4 one has no subdomains.
        if (host.startsWith('[')) return [];
        if (/^[\d.]+$/u.test(host)) return [`wss://${host}:*`];
        return [`wss://${host}:*`, `wss://*.${host}:*`];
    });
}

/** The host as the URL parser spells it, so an entry and an address compare in one form. */
function hostnameOf(entry: string): string {
    try {
        return new URL(`wss://${entry}`).hostname.replace(/\.$/u, '');
    } catch {
        // An entry no URL can carry matches no address, which is the safe reading of a typo.
        return entry;
    }
}
