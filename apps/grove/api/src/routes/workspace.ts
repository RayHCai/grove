import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
    ErrorBody,
    GameId,
    MAX_WORKSPACE_FILES,
    Workspace,
    WorkspacePath,
    WorkspaceSave,
} from '@grove/api-contract';
import type { TaskQueue } from '../queue.js';
import type { Games, Workspaces } from '../records.js';
import { requireGameOwner, requireSignedIn } from '../session.js';
import type { Storage } from '../storage.js';
import { unattached } from '../reply.js';
import { readFile, saveWorkspace } from '../workflows/workspace.js';

/** What a browser may keep a file for: nothing, because a key is overwritten in place. */
const REVALIDATE = 'private, no-cache';

/** Room for a save touching every script at once, which a rename across a project is. */
const MAX_SAVE_BYTES = 8 * 1024 * 1024;

export interface WorkspaceDeps {
    games: Pick<Games, 'ownerOf'>;
    workspaces: Workspaces;
    storage: Storage;
    queue: TaskQueue;
}

/** The files a game is authored from: the set, the bytes behind it, the save moving it on. */
export function workspaceRoutes(deps: WorkspaceDeps): FastifyPluginAsyncZod {
    return async (app) => {
        requireSignedIn(app);
        app.addHook('preHandler', requireGameOwner(deps.games));

        app.get(
            '/games/:gameId/workspace',
            {
                schema: {
                    tags: ['workspace'],
                    params: z.object({ gameId: GameId }),
                    response: { 200: Workspace, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
                },
            },
            async (request, reply) => {
                const workspace = await deps.workspaces.workspaceOf(request.params.gameId);
                if (workspace === undefined) {
                    return reply.code(404).send({ code: 'not_found', message: 'no such game' });
                }
                const { saveId: _saveId, ...visible } = workspace;
                return reply.send(visible);
            },
        );

        app.put(
            '/games/:gameId/workspace',
            {
                // The ceiling is the save's: every other body here is a form.
                bodyLimit: MAX_SAVE_BYTES,
                schema: {
                    tags: ['workspace'],
                    params: z.object({ gameId: GameId }),
                    body: WorkspaceSave,
                    response: {
                        200: Workspace,
                        400: ErrorBody,
                        401: ErrorBody,
                        403: ErrorBody,
                        404: ErrorBody,
                        409: ErrorBody,
                        413: ErrorBody,
                        415: ErrorBody,
                        501: ErrorBody,
                        502: ErrorBody,
                    },
                },
            },
            async (request, reply) => {
                const saved = await saveWorkspace(
                    { ...deps, log: request.log },
                    request.params.gameId,
                    request.viewer.playerId,
                    request.body,
                );
                switch (saved.outcome) {
                    case 'saved': {
                        const { saveId: _saveId, ...visible } = saved.workspace;
                        return reply.send(visible);
                    }
                    case 'missing':
                        return reply.code(404).send({ code: 'not_found', message: 'no such game' });
                    // The revision it moved to, so a losing editor can say what it reloads from.
                    case 'stale':
                        return reply.code(409).send({
                            code: 'conflict',
                            message: `the workspace is at revision ${String(saved.revision)}`,
                        });
                    case 'too_many':
                        return reply.code(400).send({
                            code: 'invalid_request',
                            message: `a game may hold ${String(MAX_WORKSPACE_FILES)} files`,
                        });
                    case 'too_large':
                        return reply.code(413).send({
                            code: 'invalid_request',
                            message: `${saved.path} is too large to save`,
                        });
                    case 'not_uploaded':
                        return reply.code(400).send({
                            code: 'invalid_request',
                            message: `this asset was never uploaded: ${saved.path}`,
                        });
                    case 'unacceptable':
                        return reply.code(415).send({
                            code: 'invalid_request',
                            message: `${saved.path} is not a type an asset may be`,
                        });
                    case 'unattached':
                        return unattached(reply, 'games bucket');
                    case 'unstored':
                        return reply.code(502).send({
                            code: 'internal',
                            message: `${saved.path} could not be stored`,
                        });
                }
            },
        );

        // A wildcard because a path carries slashes; what the rows name is all this game may read.
        app.get(
            '/games/:gameId/files/*',
            {
                // No response schema: the body is the file's own bytes, streamed rather than held.
                schema: {
                    tags: ['workspace'],
                    params: z.object({ gameId: GameId, '*': WorkspacePath }),
                },
            },
            async (request, reply) => {
                const found = await readFile(deps, request.params.gameId, request.params['*']);
                if (found === undefined) {
                    return reply.code(404).send({ code: 'not_found', message: 'no such file' });
                }
                return reply
                    .header('cache-control', REVALIDATE)
                    .header('content-length', found.byteLength)
                    .type(found.contentType)
                    .send(found.body);
            },
        );
    };
}
