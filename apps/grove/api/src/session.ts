import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';
import type { GameId, PlayerId } from '@grove/api-contract';
import type { Records } from './records.js';

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

/** Methods that change nothing, so a forged one costs nothing and a plain link keeps working. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Refuses anything without a logged-in session. Add it to a scope, never to a single route. */
export async function requireSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const playerId = request.session.playerId;
    if (playerId === undefined) {
        await reply.code(401).send({ code: 'unauthorized', message: 'sign in first' });
        return;
    }
    request.viewer = { playerId };
}

/**
 * Refuses a write whose caller cannot prove it read the token this service handed out at sign-in.
 *
 * `SameSite=Lax` already keeps the cookie off cross-site writes, so what is left to cover is the
 * sibling subdomain: same-site by registrable domain, and hostile all the same.
 */
export function requireCsrfToken(app: FastifyInstance): onRequestHookHandler {
    return (request, reply, done) => {
        if (SAFE_METHODS.has(request.method)) {
            done();
            return;
        }
        app.csrfProtection(request, reply, done);
    };
}

/**
 * Refuses a game the viewer does not own, which holding a session says nothing about.
 *
 * A `preHandler` rather than an `onRequest` hook: the id is validated by then, so the lookup is
 * made with a `GameId` rather than with whatever string the path carried.
 */
export function requireGameOwner(records: Records) {
    return async function hook(
        request: FastifyRequest<{ Params: { gameId: GameId } }>,
        reply: FastifyReply,
    ): Promise<void> {
        const owner = await records.ownerOf(request.params.gameId);
        // One answer for "not yours" and "no such game": which exist is not this route's to say.
        if (owner !== request.viewer.playerId) {
            await reply.code(403).send({ code: 'forbidden', message: 'not your game' });
        }
    };
}
