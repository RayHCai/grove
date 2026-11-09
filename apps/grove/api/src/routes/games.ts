import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ErrorBody, Game, GameId, GameUpdate, NEXT_CURSOR_HEADER } from '@grove/api-contract';
import type { GameCursor, Games } from '../records.js';
import type { Storage } from '../storage.js';
import { requireGameOwner, requireSignedIn } from '../session.js';
import { GameTitle } from '../values.js';
import { unattached } from '../reply.js';
import { deleteGame } from '../workflows/games.js';

/** A page, and the most a page holds: a creator with more games pages through them. */
const PAGE_LIMIT = 100;

/** Where one page stopped, opaque to the caller so the listing's order stays this service's own. */
const Cursor = z.tuple([z.iso.datetime(), GameId]);

function encodeCursor(cursor: GameCursor): string {
    return Buffer.from(JSON.stringify([cursor.createdAt, cursor.gameId]), 'utf8').toString(
        'base64url',
    );
}

function decodeCursor(text: string): GameCursor | undefined {
    try {
        const parsed = Cursor.safeParse(
            JSON.parse(Buffer.from(text, 'base64url').toString('utf8')),
        );
        return parsed.success ? { createdAt: parsed.data[0], gameId: parsed.data[1] } : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Creating a game, and listing the ones a creator already made. Neither carries a `:gameId`, which
 * is why `requireGameOwner` is absent: on a scope holding a create it would refuse everybody.
 */
export function gameRoutes(games: Games): FastifyPluginAsyncZod {
    return async (app) => {
        requireSignedIn(app);

        app.post(
            '/games',
            {
                schema: {
                    tags: ['games'],
                    body: z.object({ title: GameTitle }),
                    response: {
                        201: Game,
                        400: ErrorBody,
                        401: ErrorBody,
                        403: ErrorBody,
                        501: ErrorBody,
                    },
                },
            },
            async (request, reply) => {
                const created = await games.createGame(request.viewer.playerId, request.body.title);
                if (created.outcome === 'unattached') {
                    return unattached(reply, 'game store');
                }
                return reply.code(201).send(created.game);
            },
        );

        // The body stays the array it always was, and the next page is named in a header beside it.
        app.get(
            '/games',
            {
                schema: {
                    tags: ['games'],
                    querystring: z.object({
                        cursor: z.string().max(256).optional(),
                        limit: z.coerce.number().int().min(1).max(PAGE_LIMIT).default(PAGE_LIMIT),
                    }),
                    response: { 200: z.array(Game), 400: ErrorBody, 401: ErrorBody },
                },
            },
            async (request, reply) => {
                const { cursor, limit } = request.query;
                const after = cursor === undefined ? undefined : decodeCursor(cursor);
                if (cursor !== undefined && after === undefined) {
                    return reply.code(400).send({
                        code: 'invalid_request',
                        message: 'not a cursor this listing gave',
                    });
                }
                const page = await games.gamesOf(request.viewer.playerId, limit, after);
                if (page.next !== undefined) {
                    void reply.header(NEXT_CURSOR_HEADER, encodeCursor(page.next));
                }
                return reply.send(page.games);
            },
        );
    };
}

/** Changing or deleting a game a creator owns, in a scope of its own for the ownership hook. */
export function gameSettingsRoutes(games: Games, storage: Storage): FastifyPluginAsyncZod {
    return async (app) => {
        requireSignedIn(app);
        app.addHook('preHandler', requireGameOwner(games));

        app.patch(
            '/games/:gameId',
            {
                schema: {
                    tags: ['games'],
                    params: z.object({ gameId: GameId }),
                    body: GameUpdate,
                    response: {
                        200: Game,
                        400: ErrorBody,
                        401: ErrorBody,
                        403: ErrorBody,
                        404: ErrorBody,
                        501: ErrorBody,
                    },
                },
            },
            async (request, reply) => {
                // The one write that makes a game reachable; publishing and building do not.
                if (request.body.visibility === undefined) {
                    const game = await games.gameOf(request.params.gameId);
                    if (game === undefined) {
                        return reply.code(404).send({ code: 'not_found', message: 'no such game' });
                    }
                    return reply.send(game);
                }

                const updated = await games.setVisibility(
                    request.params.gameId,
                    request.body.visibility,
                );
                if (updated.outcome === 'missing') {
                    return reply.code(404).send({ code: 'not_found', message: 'no such game' });
                }
                if (updated.outcome === 'unattached') {
                    return unattached(reply, 'game store');
                }
                return reply.send(updated.game);
            },
        );

        app.delete(
            '/games/:gameId',
            {
                schema: {
                    tags: ['games'],
                    params: z.object({ gameId: GameId }),
                    response: {
                        204: z.null(),
                        401: ErrorBody,
                        403: ErrorBody,
                        404: ErrorBody,
                        501: ErrorBody,
                        502: ErrorBody,
                    },
                },
            },
            async (request, reply) => {
                const deleted = await deleteGame({ games, storage }, request.params.gameId);
                if (deleted.outcome === 'unavailable') {
                    return reply
                        .code(502)
                        .send({ code: 'internal', message: 'the game files could not be deleted' });
                }
                if (deleted.outcome === 'missing') {
                    return reply.code(404).send({ code: 'not_found', message: 'no such game' });
                }
                if (deleted.outcome === 'unattached') {
                    return unattached(reply, 'game store');
                }
                return reply.code(204).send(null);
            },
        );
    };
}
