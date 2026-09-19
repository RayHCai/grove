import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';
import type { GameId, PlayerId } from '@grove/api-contract';
import type { Records } from './records.js';

declare module 'fastify' {
    interface FastifyRequest {
        /**
         * Who is asking, once `requireSession` has run. The type is global because module
         * augmentation is; the VALUE exists only in a scope that registered the hook.
         */
        viewer: Viewer;
    }

    /**
     * Augmented on the base rather than on `FastifySessionObject`, which extends it: the session
     * store holds this type, and `destroyFor` has to be able to read who a held session belongs to.
     */
    interface Session {
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
 * Refuses a write whose caller cannot prove it read the token handed out at sign-in.
 * `SameSite=Lax` already covers cross-site; what is left is the sibling subdomain.
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
 * A `preHandler`, not `onRequest`: by then the id is validated, so the lookup takes a `GameId`.
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

/**
 * Puts an identity into a fresh session and hands back the token its next write must carry.
 * Every sign-in path goes through here, so the rotation cannot be the step a new one forgets.
 */
export async function beginSession(
    request: FastifyRequest,
    reply: FastifyReply,
    playerId: PlayerId,
): Promise<string> {
    const abandoned = request.session.sessionId;
    // Rotate before writing identity into it, or a session fixed by an attacker before the login
    // survives it.
    await request.session.regenerate();
    // The rotation stores the new id and leaves the old one holding this account, so a cookie
    // stolen before this sign-in would answer for it until the day was out.
    await forget(request, abandoned);
    request.session.playerId = playerId;
    // Minted after the rotation and never carried across it: a secret planted before the login
    // would otherwise verify a token the planter already holds.
    return reply.generateCsrf();
}

/** The store is the only handle left on a session the plugin has already stopped tracking. */
async function forget(request: FastifyRequest, sessionId: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        request.sessionStore.destroy(sessionId, (error) => (error ? reject(error) : resolve()));
    });
}
