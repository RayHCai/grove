import type { FastifyBaseLogger } from 'fastify';
import type { Env } from './env.js';

/** `unattached` is nobody configured to carry the mail, which is not the same as failing to send. */
export type Delivered = { outcome: 'sent' } | { outcome: 'unattached' } | { outcome: 'failed' };

/**
 * Where a password reset link goes.
 *
 * A seam rather than a provider, because this repo names no mail service: the whole flow — minting
 * the key, its digest, its expiry, spending it once — is decided here, and which provider carries
 * the message is one function somebody attaches in `main.ts`.
 */
export interface Mailer {
    sendPasswordReset(to: string, link: string): Promise<Delivered>;
}

/** The mail seam with nothing behind it: asking for a reset is a 501 rather than a silent nothing. */
export const unattachedMailer: Mailer = {
    sendPasswordReset: async () => ({ outcome: 'unattached' }),
};

/**
 * Writes the link to the service log instead of sending it, so a developer with no provider can
 * still walk the flow.
 *
 * `main.ts` wires this only outside production, and the one-line reason is that a log line is a
 * delivered password reset to everyone who can read the log.
 */
export function loggingMailer(log: () => FastifyBaseLogger): Mailer {
    return {
        sendPasswordReset: async (to, link) => {
            // Reached through a thunk because the logger belongs to the app, and the app is built
            // with this mailer already in hand.
            log().warn(
                { to, link },
                'password reset not mailed: writing the link to the log instead',
            );
            return { outcome: 'sent' };
        },
    };
}

/** The link a reset mail carries, which is a page on the platform origin rather than this service. */
export function resetLink(env: Env, token: string): string {
    const url = new URL('/reset-password', env.PLATFORM_ORIGIN);
    url.searchParams.set('token', token);
    return url.toString();
}
