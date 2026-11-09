import { normalizeIP } from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** Per person, every route: opening the largest game (a read per file) plus autosave fits. */
export const GENERAL_PER_MINUTE = 1200;

/** Credential attempts per address: ten classes behind one school NAT, a mistype each. */
export const CREDENTIAL_PER_ADDRESS = 300;

/** Attempts at one account from one address, which the account's own lockout backs up. */
export const CREDENTIAL_PER_ACCOUNT = 10;

export const LIMIT_WINDOW = '1 minute';

/** Players and addresses both, so a classroom behind one NAT is a budget per student. */
const GENERAL_KEYS = 100_000;

/** The general limiter's options: a preHandler, so the session it keys on has been read. */
export function generalLimit() {
    return {
        global: true,
        hook: 'preHandler' as const,
        max: GENERAL_PER_MINUTE,
        timeWindow: LIMIT_WINDOW,
        cache: GENERAL_KEYS,
        keyGenerator: (request: FastifyRequest) => {
            const player = request.session?.playerId;
            return player === undefined ? `address ${normalizeIP(request.ip)}` : `player ${player}`;
        },
    };
}

/** The two hooks every route that takes a credential carries in place of the general limit. */
export interface CredentialLimits {
    /** Before the body is read, so a flood of garbage is counted against its address too. */
    perAddress: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Once the address is folded into the body, so one student's typos cost nobody else. */
    perAccount: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

type Check = ReturnType<FastifyInstance['createRateLimit']>;

/** Built once for the app, so sign-in, sign-up and a reset request spend one shared budget. */
export function credentialLimits(app: FastifyInstance): CredentialLimits {
    const address = app.createRateLimit({
        max: CREDENTIAL_PER_ADDRESS,
        timeWindow: LIMIT_WINDOW,
        keyGenerator: (request) => normalizeIP(request.ip),
    });
    const account = app.createRateLimit({
        max: CREDENTIAL_PER_ACCOUNT,
        timeWindow: LIMIT_WINDOW,
        keyGenerator: (request) => `${normalizeIP(request.ip)} ${emailOf(request)}`,
    });
    return { perAddress: enforce(address), perAccount: enforce(account) };
}

/** The address the route's schema already folded, which is what one account is named by. */
function emailOf(request: FastifyRequest): string {
    const email = (request.body as { email?: unknown } | undefined)?.email;
    return typeof email === 'string' ? email : '';
}

function enforce(check: Check) {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
        const verdict = await check(request);
        if (verdict.isAllowed) return;
        void reply
            .header('x-ratelimit-limit', verdict.max)
            .header('x-ratelimit-remaining', verdict.remaining)
            .header('x-ratelimit-reset', verdict.ttlInSeconds);
        if (!verdict.isExceeded) return;
        void reply.header('retry-after', verdict.ttlInSeconds);
        throw Object.assign(
            new Error(`rate limit exceeded, retry in ${String(verdict.ttlInSeconds)} seconds`),
            { statusCode: 429 },
        );
    };
}
