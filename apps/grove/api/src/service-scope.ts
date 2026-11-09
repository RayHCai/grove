import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { TaskKind } from '@grove/api-contract';
import type { Env } from './env.js';

/** Which fleet service is calling, as the secret it presented says and nothing else does. */
export type Caller = 'server-manager' | 'builder' | 'asset-service';

declare module 'fastify' {
    interface FastifyRequest {
        /** Set by `admit` in the scopes that register it, and undefined anywhere else. */
        caller: Caller;
    }
}

const SECRET_OF = {
    'server-manager': 'SERVER_MANAGER_SECRET',
    builder: 'BUILDER_SECRET',
    'asset-service': 'ASSET_SERVICE_SECRET',
} as const satisfies Record<Caller, keyof Env>;

/** The one kind of task each worker's secret may claim and settle. */
export const KIND_OF = {
    builder: 'BUILD',
    'asset-service': 'ASSET_UPLOAD',
} as const satisfies Record<Exclude<Caller, 'server-manager'>, TaskKind>;

/** A scope hook admitting the named callers by their own secrets, so an added route is covered. */
export function admit(env: Env, ...callers: Caller[]) {
    const expected = callers.map((caller) => ({
        caller,
        secret: Buffer.from(env[SECRET_OF[caller]], 'utf8'),
    }));

    return async function hook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
        const header = request.headers.authorization;
        if (header === undefined || !header.startsWith('Bearer ')) {
            await reply.code(401).send({ code: 'unauthorized', message: 'no bearer' });
            return;
        }

        const presented = Buffer.from(header.slice('Bearer '.length), 'utf8');
        // Every candidate is compared, and only the length leaks, which the format already fixes.
        let matched: Caller | undefined;
        for (const { caller, secret } of expected) {
            if (presented.length === secret.length && timingSafeEqual(presented, secret)) {
                matched = caller;
            }
        }
        if (matched === undefined) {
            request.log.warn('bearer refused');
            await reply.code(401).send({ code: 'unauthorized', message: 'bad bearer' });
            return;
        }
        request.caller = matched;
    };
}

/** The route config every fleet route carries: the bearer is their gate, not a browser's budget. */
export const UNLIMITED = { rateLimit: false } as const;
