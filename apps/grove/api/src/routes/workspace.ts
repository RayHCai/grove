import { z } from 'zod';
import type { FastifyBaseLogger } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
    ErrorBody,
    GameId,
    MAX_ASSET_BYTES,
    MAX_SOURCE_BYTES,
    MAX_WORKSPACE_FILES,
    MediaType,
    Workspace,
    WorkspacePath,
    WorkspaceSave,
    encodeManifest,
    manifestKey,
    objectKey,
    type Task,
    type WorkspaceFile,
} from '@grove/api-contract';
import type { TaskQueue } from '../queue.js';
import type { FileUpsert, Records } from '../records.js';
import { requireCsrfToken, requireGameOwner, requireSession } from '../session.js';
import type { Storage } from '../storage.js';

/** What a browser may keep a file for: nothing, because a key is overwritten in place. */
const REVALIDATE = 'private, no-cache';

/**
 * Room for a save that touches every script in a game at once, which is what a rename or a
 * find-and-replace across a project is.
 */
const MAX_SAVE_BYTES = 8 * 1024 * 1024;

/** What a manifest is stored as, which is what @grove/game-builder fetches and parses. */
const MANIFEST_TYPE = 'application/json';

/** What a file is recorded as when the bucket said nothing useful about it. */
const OPAQUE = MediaType.parse('application/octet-stream');

/**
 * The files a game is authored from: the set, the bytes behind it, and the save that moves it on.
 *
 * A save carries the text of what changed and the path of what was removed. Assets are not here —
 * their bytes went straight to the bucket through a presigned PUT, and a save names the path so
 * this service can read back what actually landed.
 */
export function workspaceRoutes(
    records: Records,
    storage: Storage,
    queue: TaskQueue,
): FastifyPluginAsyncZod {
    return async (app) => {
        app.addHook('onRequest', requireSession);
        app.addHook('onRequest', requireCsrfToken(app));
        app.addHook('preHandler', requireGameOwner(records));

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
                const workspace = await records.workspaceOf(request.params.gameId);
                if (workspace === undefined) {
                    return reply.code(404).send({ code: 'not_found', message: 'no such game' });
                }
                return reply.send(workspace);
            },
        );

        app.put(
            '/games/:gameId/workspace',
            {
                // The ceiling is the save rather than the service: every other body here is a form,
                // and a megabyte of them would be a caller doing something else.
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
                        501: ErrorBody,
                        502: ErrorBody,
                    },
                },
            },
            async (request, reply) => {
                const game = request.params.gameId;
                const save = request.body;
                const current = await records.workspaceOf(game);
                if (current === undefined) {
                    return reply.code(404).send({ code: 'not_found', message: 'no such game' });
                }

                // Counted against what the game already holds minus what this save removes: a save
                // that replaces a file does not grow the set, and one that adds may not overrun it.
                const kept = current.files.filter(
                    (file) => !save.deletes.includes(file.path),
                ).length;
                const added = [...save.sources.map((file) => file.path), ...save.assets].filter(
                    (path) => !current.files.some((file) => file.path === path),
                ).length;
                if (kept + added > MAX_WORKSPACE_FILES) {
                    return reply.code(400).send({
                        code: 'invalid_request',
                        message: `a game may hold ${String(MAX_WORKSPACE_FILES)} files`,
                    });
                }

                const upserts: FileUpsert[] = [];

                // The bytes go first, and a save that turns out stale leaves versions no manifest
                // names — which the bucket's own expiry collects, and which no read can reach.
                for (const source of save.sources) {
                    const body = Buffer.from(source.text, 'utf8');
                    if (body.byteLength > MAX_SOURCE_BYTES) {
                        return reply.code(413).send({
                            code: 'invalid_request',
                            message: `${source.path} is too large to save as source`,
                        });
                    }
                    // oxlint-disable-next-line no-await-in-loop
                    const written = await storage.put(
                        objectKey(game, 'source', source.path),
                        body,
                        source.contentType,
                    );
                    if (written.outcome === 'unattached') {
                        return reply
                            .code(501)
                            .send({ code: 'internal', message: 'no games bucket is attached' });
                    }
                    if (written.outcome !== 'written') {
                        return reply.code(502).send({
                            code: 'internal',
                            message: `${source.path} could not be stored`,
                        });
                    }
                    upserts.push({
                        path: source.path,
                        kind: 'source',
                        versionId: written.version.versionId,
                        byteLength: written.version.byteLength,
                        contentType: source.contentType,
                    });
                }

                // An asset's bytes never passed through here, so what it landed as is read from the
                // bucket rather than taken from the editor that claims to have sent it.
                for (const path of save.assets) {
                    // oxlint-disable-next-line no-await-in-loop
                    const landed = await storage.head(objectKey(game, 'asset', path));
                    if (landed === undefined) {
                        return reply.code(400).send({
                            code: 'invalid_request',
                            message: `this asset was never uploaded: ${path}`,
                        });
                    }
                    if (landed.byteLength > MAX_ASSET_BYTES) {
                        return reply.code(413).send({
                            code: 'invalid_request',
                            message: `${path} is larger than an asset may be`,
                        });
                    }
                    upserts.push({
                        path,
                        kind: 'asset',
                        versionId: landed.versionId,
                        byteLength: landed.byteLength,
                        contentType: storedType(landed.contentType),
                    });
                }

                const saved = await records.saveWorkspace(game, {
                    baseRevision: save.baseRevision,
                    accountId: request.viewer.playerId,
                    upserts,
                    deletes: save.deletes,
                    freeze: async (revision, files) => freeze(storage, game, revision, files),
                });

                if (saved.outcome === 'missing') {
                    return reply.code(404).send({ code: 'not_found', message: 'no such game' });
                }
                // The revision it moved to, so an editor that lost the race can say what it is
                // reloading from rather than only that it lost.
                if (saved.outcome === 'stale') {
                    return reply.code(409).send({
                        code: 'conflict',
                        message: `the workspace is at revision ${String(saved.workspace.revision)}`,
                    });
                }
                if (saved.outcome === 'unfrozen') {
                    return reply
                        .code(502)
                        .send({ code: 'internal', message: 'the manifest could not be written' });
                }

                // After the commit, never before: a delete issued for a save that turned out stale
                // would be a creator losing a file to somebody else's race.
                for (const path of save.deletes) {
                    // oxlint-disable-next-line no-await-in-loop
                    await storage.remove(objectKey(game, 'source', path));
                    // oxlint-disable-next-line no-await-in-loop
                    await storage.remove(objectKey(game, 'asset', path));
                }

                await announce(queue, saved.tasks, request.log);
                return reply.send(saved.workspace);
            },
        );

        // A wildcard because a workspace path carries slashes, and the file is fetched by the
        // version the rows name: what this game holds is what it may read, and nothing else.
        app.get(
            '/games/:gameId/files/*',
            {
                // No response schema: the body is the file's own bytes, and a serializer compiled
                // for this route would turn every asset into JSON. Its refusals carry `ErrorBody`
                // all the same — they are written by hand below.
                schema: {
                    tags: ['workspace'],
                    params: z.object({ gameId: GameId, '*': WorkspacePath }),
                },
            },
            async (request, reply) => {
                const path = request.params['*'];
                const file = await records.fileOf(request.params.gameId, path);
                if (file === undefined) {
                    return reply.code(404).send({ code: 'not_found', message: 'no such file' });
                }

                const found = await storage.get(
                    objectKey(request.params.gameId, file.kind, path),
                    file.versionId,
                );
                if (found === undefined) {
                    return reply.code(404).send({ code: 'not_found', message: 'no such file' });
                }
                // A key is overwritten in place, so what is current at it changes: the browser
                // revalidates rather than holding bytes that have since been saved over.
                return reply
                    .header('cache-control', REVALIDATE)
                    .type(found.contentType)
                    .send(found.body);
            },
        );
    };
}

/**
 * The type the bucket answered with, narrowed to what a manifest may carry.
 *
 * Parameters are dropped rather than refused: a browser presigns `image/png` and gets back
 * `image/png; charset=binary` from some stacks. Anything that is not a media type at all becomes
 * opaque bytes, which is what an unnamed upload already is.
 */
function storedType(header: string): MediaType {
    const parsed = MediaType.safeParse(header.split(';')[0]?.trim().toLowerCase());
    return parsed.success ? parsed.data : OPAQUE;
}

/** Writes the snapshot this save froze; `false` is a manifest the save has to be rolled back for. */
async function freeze(
    storage: Storage,
    game: GameId,
    revision: number,
    files: WorkspaceFile[],
): Promise<boolean> {
    const written = await storage.put(
        manifestKey(game, revision),
        Buffer.from(encodeManifest({ gameId: game, revision, files }), 'utf8'),
        MANIFEST_TYPE,
    );
    return written.outcome === 'written';
}

/**
 * Tells the upload service what was queued.
 *
 * A push that did not land is logged rather than failed: the row is already committed, and the
 * sweeper re-pushes anything still sitting unclaimed. Reporting a save as failed here would be
 * telling a creator their file is gone over a message that will be sent again in a minute.
 */
async function announce(
    queue: TaskQueue,
    tasks: readonly Task[],
    log: FastifyBaseLogger,
): Promise<void> {
    for (const task of tasks) {
        // oxlint-disable-next-line no-await-in-loop
        const pushed = await queue.push(task.kind, task.taskId);
        if (pushed.outcome !== 'pushed') {
            log.warn({ taskId: task.taskId, outcome: pushed.outcome }, 'task not announced');
        }
    }
}
