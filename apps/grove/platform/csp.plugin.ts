// The platform page's Content-Security-Policy, carried as a `<meta>` because a static host is told
// nothing but the files, and the headers that host has to send which a `<meta>` cannot carry.

import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';

function originOf(url: string | undefined): string | undefined {
    if (url === undefined || url === '') return undefined;
    try {
        return new URL(url).origin;
    } catch {
        return undefined;
    }
}

/** What the page may load: its own scripts and any inline one by hash, the fonts, and the API. */
export function platformPolicy(
    html: string,
    apiUrl: string | undefined,
    beaconUrl: string | undefined = undefined,
): string {
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map(
        ([, script = '']) => `'sha256-${createHash('sha256').update(script).digest('base64')}'`,
    );
    const reached = [originOf(apiUrl), originOf(beaconUrl)].filter(
        (origin): origin is string => origin !== undefined,
    );
    return [
        "default-src 'self'",
        ['script-src', "'self'", ...inline].join(' '),
        "style-src 'self' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data:",
        // The API alone: this is the origin a password is typed on, so nothing else is dialled.
        ['connect-src', "'self'", ...new Set(reached)].join(' '),
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
    ].join('; ');
}

/** What a host sends with every response, since a `<meta>` policy cannot forbid framing. */
export const HOST_HEADERS: Readonly<Record<string, string>> = {
    'content-security-policy': "frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
};

function sendHostHeaders(
    _request: unknown,
    response: { setHeader(name: string, value: string): unknown },
    next: () => void,
): void {
    for (const [name, value] of Object.entries(HOST_HEADERS)) response.setHeader(name, value);
    next();
}

/** Gives a built page its policy, and a dev or preview server the headers a host would send. */
export function contentSecurity(): Plugin {
    let env: Record<string, unknown> = {};
    let building = false;
    return {
        name: 'grove-platform-csp',
        configResolved(config) {
            env = config.env;
            building = config.command === 'build';
        },
        configureServer(server) {
            server.middlewares.use(sendHostHeaders);
        },
        configurePreviewServer(server) {
            server.middlewares.use(sendHostHeaders);
        },
        transformIndexHtml: {
            order: 'post',
            handler(html) {
                // A dev server's React refresh preamble is an inline script this policy refuses.
                if (!building) return html;
                const policy = platformPolicy(
                    html,
                    env['VITE_API_URL'] as string | undefined,
                    env['VITE_ERROR_BEACON_URL'] as string | undefined,
                );
                return html.replace(
                    '<head>',
                    `<head>\n        <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
                );
            },
        },
    };
}
