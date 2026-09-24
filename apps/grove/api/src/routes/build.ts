import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
    BuildArtifact,
    BuildOutputName,
    ErrorBody,
    GameId,
    Manifest,
    WorkspacePath,
    buildPrefix,
    manifestKey,
    objectKey,
} from '@grove/api-contract';
import type { WorkspaceFile } from '@grove/api-contract';
import type { Env } from '../env.js';
import { verifyFleetSecret } from '../service-scope.js';
import type { Storage } from '../storage.js';

/** What a build output is served as when nothing better is known; chunks are JavaScript. */
const OPAQUE = 'application/octet-stream';

/** A manifest is small and a build output is a chunk, so neither is streamed. */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** A revision is what a task is pinned to, so it is positive: revision zero was never saved. */
const Revision = z.coerce.number().int().positive();

/**
 * How a build box reads the source it was told to compile and writes what came out.
 *
 * It holds no bucket credential, so every byte it touches goes through here. That is the point:
 * what it may read is one frozen manifest's files at the versions that manifest named, and what it
 * may write is the prefix its own revision owns. A builder cannot reach another game, another
 * revision, or a key outside the build prefix, because no route here spells one.
 */
export function fleetBuildRoutes(storage: Storage, env: Env): FastifyPluginAsyncZod {
    return async (app) => {
        app.addHook('onRequest', verifyFleetSecret(env));

        // Every body in this scope is a build output, which is bytes and never a value. The JSON
        // parser is overridden along with the rest: a build manifest that was parsed and
        // re-serialised here would be stored as bytes whose hash is not the one it was written as.
        app.addContentTypeParser(
            ['*', 'application/json'],
            { parseAs: 'buffer' },
            (_request, body, done) => {
                done(null, body);
            },
        );

        app.get(
            '/fleet/games/:gameId/revisions/:revision/manifest',
            {
                schema: {
                    tags: ['build'],
                    params: z.object({ gameId: GameId, revision: Revision }),
                    response: { 200: Manifest, 401: ErrorBody, 404: ErrorBody },
                },
            },
            async (request, reply) => {
                const frozen = await manifestOf(
                    storage,
                    request.params.gameId,
                    request.params.revision,
                );
                if (frozen === undefined) {
                    return reply.code(404).send({ code: 'not_found', message: 'no such manifest' });
                }
                return reply.send(frozen);
            },
        );

        // A wildcard because a workspace path carries slashes. The version is the manifest's and
        // never the caller's: a build compiles the snapshot it was pinned to, and reading whatever
        // is current at a key would let an edit made after the publish reach the compiler.
        app.get(
            '/fleet/games/:gameId/revisions/:revision/files/*',
            {
                // No response schema: the body is the file's own bytes, and a serializer compiled
                // for this route would turn every asset into JSON.
                schema: {
                    tags: ['build'],
                    params: z.object({
                        gameId: GameId,
                        revision: Revision,
                        '*': WorkspacePath,
                    }),
                },
            },
            async (request, reply) => {
                const game = request.params.gameId;
                const frozen = await manifestOf(storage, game, request.params.revision);
                if (frozen === undefined) {
                    return reply.code(404).send({ code: 'not_found', message: 'no such manifest' });
                }

                const file: WorkspaceFile | undefined = frozen.files.find(
                    (held) => held.path === request.params['*'],
                );
                if (file === undefined) {
                    return reply.code(404).send({ code: 'not_found', message: 'no such file' });
                }

                const found = await storage.get(
                    objectKey(game, file.kind, file.path),
                    file.versionId,
                );
                if (found === undefined) {
                    return reply.code(404).send({ code: 'not_found', message: 'no such file' });
                }
                // A version is one byte-set forever, so a build box that fetched it twice would be
                // fetching the same answer.
                return reply
                    .header('cache-control', 'private, max-age=31536000, immutable')
                    .type(found.contentType)
                    .send(found.body);
            },
        );

        app.put(
            '/fleet/games/:gameId/revisions/:revision/build/:name',
            {
                bodyLimit: MAX_OUTPUT_BYTES,
                schema: {
                    tags: ['build'],
                    params: z.object({
                        gameId: GameId,
                        revision: Revision,
                        name: BuildOutputName,
                    }),
                    response: {
                        200: BuildArtifact,
                        401: ErrorBody,
                        501: ErrorBody,
                        502: ErrorBody,
                    },
                },
            },
            async (request, reply) => {
                const body = Buffer.isBuffer(request.body)
                    ? request.body
                    : Buffer.from(String(request.body), 'utf8');

                const written = await storage.put(
                    `${buildPrefix(request.params.gameId, request.params.revision)}${request.params.name}`,
                    body,
                    contentTypeOf(request.params.name, request.headers['content-type']),
                );
                if (written.outcome === 'unattached') {
                    return reply
                        .code(501)
                        .send({ code: 'internal', message: 'no games bucket is attached' });
                }
                if (written.outcome !== 'written') {
                    return reply.code(502).send({
                        code: 'internal',
                        message: 'the build output could not be stored',
                    });
                }

                return reply.send({
                    name: request.params.name,
                    // The address is this service's, so a build manifest names where the edge
                    // actually serves these bytes rather than wherever a worker guessed.
                    url: `${env.GAMES_CDN_URL.replace(/\/+$/u, '')}/${buildPrefix(request.params.gameId, request.params.revision)}${request.params.name}`,
                    // Hashed here rather than taken on trust: a handshake compares this against a
                    // digest of the bytes a browser fetched, and only the bytes that landed can
                    // make that comparison mean anything.
                    hash: createHash('sha256').update(body).digest('hex'),
                    byteLength: body.byteLength,
                });
            },
        );
    };
}

/** The snapshot one revision froze, as the bucket holds it. */
async function manifestOf(
    storage: Storage,
    game: GameId,
    revision: number,
): Promise<Manifest | undefined> {
    const found = await storage.get(manifestKey(game, revision));
    if (found === undefined) return undefined;
    // Parsed rather than cast: this is what decides which bytes a build box is handed, and a
    // manifest that does not parse is one nothing should be compiled from.
    const parsed = Manifest.safeParse(safeJson(found.body.toString('utf8')));
    if (!parsed.success || parsed.data.gameId !== game || parsed.data.revision !== revision) {
        return undefined;
    }
    return parsed.data;
}

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

/** What a build output is stored as, so the edge hands a browser something it will evaluate. */
function contentTypeOf(name: string, presented: string | undefined): string {
    if (name.endsWith('.js')) return 'text/javascript';
    if (name.endsWith('.json')) return 'application/json';
    return presented?.split(';')[0]?.trim() ?? OPAQUE;
}
