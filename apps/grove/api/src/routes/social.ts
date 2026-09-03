import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ErrorBody, PlayerId } from '@grove/api-contract';
import { requireSession } from '../session.js';

const Friend = z.object({
    playerId: PlayerId,
    displayName: z.string(),
    online: z.boolean(),
});

/**
 * Friends, presence, and the block list.
 *
 * Everything here needs a viewer AND that viewer's blocks, and the second hook is the reason this
 * is a scope rather than a shared prefix: `blockedBy` is loaded once per request for these routes
 * and for nothing else. A route added to this file inherits both. A route added to the allocator
 * inherits neither, which is what keeps a per-request friend-graph read off the join path.
 */
export const socialRoutes: FastifyPluginAsyncZod = async (app) => {
    app.addHook('onRequest', requireSession);
    app.addHook('preHandler', async (request) => {
        request.blockedBy = await loadBlocks(request.viewer.playerId);
    });

    app.get(
        '/friends',
        {
            schema: {
                tags: ['social'],
                response: { 200: z.array(Friend), 401: ErrorBody },
            },
        },
        async (request) => listFriends(request.viewer.playerId, request.blockedBy),
    );
};

declare module 'fastify' {
    interface FastifyRequest {
        /** Loaded by this scope's `preHandler`, and undefined anywhere else. */
        blockedBy: ReadonlySet<PlayerId>;
    }
}

async function loadBlocks(_viewer: PlayerId): Promise<ReadonlySet<PlayerId>> {
    return new Set();
}

async function listFriends(
    _viewer: PlayerId,
    _blockedBy: ReadonlySet<PlayerId>,
): Promise<z.infer<typeof Friend>[]> {
    return [];
}
