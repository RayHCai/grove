import type { FastifyReply } from 'fastify';

/** The answer for a seam `main.ts` left unattached, which is a deploy fault and not the caller's. */
export function unattached<Reply extends FastifyReply>(reply: Reply, seam: string): Reply {
    return reply.code(501).send({ code: 'internal', message: `no ${seam} is attached` }) as Reply;
}
