import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ErrorBody, StateKeyParams, StateRecord, StateWrite } from '@grove/api-contract';
import type { GameId } from '@grove/api-contract';

/** `@serverState`, as the engine's `KVStore` seam reaches it over HTTP. */
export const stateRoutes: FastifyPluginAsyncZod = async (app) => {
    app.get(
        '/state/:key',
        {
            schema: {
                tags: ['state'],
                params: StateKeyParams,
                response: { 200: StateRecord, 401: ErrorBody, 404: ErrorBody },
            },
        },
        async (request, reply) => {
            const record = await readState(request.gameId, request.params.key);
            if (record === undefined) {
                return reply.code(404).send({ code: 'not_found', message: 'no such key' });
            }
            return reply.send(record);
        },
    );

    app.put(
        '/state/:key',
        {
            schema: {
                tags: ['state'],
                params: StateKeyParams,
                body: StateWrite,
                response: {
                    200: z.object({ revision: z.int().nonnegative() }),
                    401: ErrorBody,
                    // A write against a stale revision is refused rather than applied: two ticks
                    // racing on one key is a bug the caller has to see, not one to paper over.
                    409: ErrorBody,
                },
            },
        },
        async (request, reply) => {
            const written = await writeState(request.gameId, request.params.key, request.body);
            if (written === undefined) {
                return reply.code(409).send({ code: 'conflict', message: 'revision moved' });
            }
            return reply.send({ revision: written });
        },
    );
};

async function readState(_game: GameId, _key: string): Promise<StateRecord | undefined> {
    return undefined;
}

async function writeState(
    _game: GameId,
    _key: string,
    _write: StateWrite,
): Promise<number | undefined> {
    return undefined;
}
