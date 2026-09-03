import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PlayerId } from '@grove/api-contract';

declare module 'fastify' {
    interface FastifyRequest {
        /**
         * Who is asking, once `requireSession` has run.
         *
         * The type is visible everywhere because module augmentation is global; the VALUE exists
         * only inside a scope that registered the hook. A route that forgot it reads `undefined`,
         * which is why the hook is registered per scope rather than per handler.
         */
        viewer: Viewer;
    }
}

declare module '@fastify/session' {
    interface FastifySessionObject {
        playerId?: PlayerId;
    }
}

export interface Viewer {
    playerId: PlayerId;
}

/** Refuses anything without a logged-in session. Add it to a scope, never to a single route. */
export async function requireSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const playerId = request.session.playerId;
    if (playerId === undefined) {
        await reply.code(401).send({ code: 'unauthorized', message: 'sign in first' });
        return;
    }
    request.viewer = { playerId };
}
