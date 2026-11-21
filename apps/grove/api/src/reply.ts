import type { FastifyReply } from 'fastify';
import type { ErrorBody } from '@grove/api-contract';

/** The status each refusal code always answers with; `internal` varies by cause and is set by hand. */
const STATUS_OF = {
    invalid_request: 400,
    unauthorized: 401,
    forbidden: 403,
    not_found: 404,
    conflict: 409,
    rate_limited: 429,
} as const satisfies Partial<Record<ErrorBody['code'], number>>;

export type Refusal = keyof typeof STATUS_OF;

/** Sends an error body under the one status its code means. */
export function refuse<Reply extends FastifyReply>(
    reply: Reply,
    code: Refusal,
    message: string,
): Reply {
    return reply.code(STATUS_OF[code]).send({ code, message }) as Reply;
}

/** The answer for a seam `main.ts` left unattached, which is a deploy fault and not the caller's. */
export function unattached<Reply extends FastifyReply>(reply: Reply, seam: string): Reply {
    return reply.code(501).send({ code: 'internal', message: `no ${seam} is attached` }) as Reply;
}
