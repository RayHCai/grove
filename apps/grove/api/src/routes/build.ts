import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
    BuildArtifact,
    BuildOutputName,
    ErrorBody,
    Manifest,
    TaskId,
    WorkspacePath,
} from '@grove/api-contract';
import type { Env } from '../env.js';
import type { Tasks } from '../records.js';
import { UNLIMITED, admit } from '../service-scope.js';
import type { Storage } from '../storage.js';
import { unattached } from '../reply.js';
import { ManifestCache, manifestFor, sourceFor, storeOutput } from '../workflows/build.js';

/** A source file is a script and a build output is a chunk, so neither is streamed. */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** A claimed build nobody holds is refused rather than read: its source is no worker's business. */
const UNCLAIMED = { code: 'conflict', message: 'the build is not claimed' } as const;

/**
 * How a build box reads the source of the build it claimed and stores what came out, all scoped to
 * that one task, so the builder secret reaches no game nobody asked it to build.
 */
export function fleetBuildRoutes(
    tasks: Pick<Tasks, 'buildOf' | 'recordArtifact'>,
    storage: Storage,
    env: Env,
): FastifyPluginAsyncZod {
    return async (app) => {
        app.addHook('onRequest', admit(env, 'builder'));
        const deps = { tasks, storage, manifests: new ManifestCache(), cdnUrl: env.GAMES_CDN_URL };

        // Bytes and never a value, so a manifest is stored under the hash of what was written.
        app.addContentTypeParser(
            ['*', 'application/json'],
            { parseAs: 'buffer' },
            (_request, body, done) => {
                done(null, body);
            },
        );

        app.get(
            '/fleet/tasks/:taskId/manifest',
            {
                config: UNLIMITED,
                schema: {
                    tags: ['build'],
                    params: z.object({ taskId: TaskId }),
                    response: {
                        200: Manifest,
                        401: ErrorBody,
                        404: ErrorBody,
                        409: ErrorBody,
                        503: ErrorBody,
                    },
                },
            },
            async (request, reply) => {
                const found = await manifestFor(deps, request.params.taskId);
                if (found.outcome === 'unclaimed') return reply.code(409).send(UNCLAIMED);
                if (found.outcome === 'missing') {
                    return reply.code(404).send({ code: 'not_found', message: 'no such manifest' });
                }
                return reply.send(found.value);
            },
        );

        // The manifest's version, never the caller's, so a later edit cannot reach a compiler.
        app.get(
            '/fleet/tasks/:taskId/files/*',
            {
                // No response schema: the body is the file's own bytes.
                config: UNLIMITED,
                schema: {
                    tags: ['build'],
                    params: z.object({ taskId: TaskId, '*': WorkspacePath }),
                },
            },
            async (request, reply) => {
                const found = await sourceFor(deps, request.params.taskId, request.params['*']);
                if (found.outcome === 'unclaimed') return reply.code(409).send(UNCLAIMED);
                if (found.outcome === 'missing') {
                    return reply.code(404).send({ code: 'not_found', message: 'no such file' });
                }
                // A version is one byte-set forever, so fetching it twice fetches the same answer.
                return reply
                    .header('cache-control', 'private, max-age=31536000, immutable')
                    .type(found.value.contentType)
                    .send(found.value.body);
            },
        );

        app.put(
            '/fleet/tasks/:taskId/build/:name',
            {
                bodyLimit: MAX_OUTPUT_BYTES,
                config: UNLIMITED,
                schema: {
                    tags: ['build'],
                    params: z.object({ taskId: TaskId, name: BuildOutputName }),
                    response: {
                        200: BuildArtifact,
                        401: ErrorBody,
                        404: ErrorBody,
                        409: ErrorBody,
                        501: ErrorBody,
                        502: ErrorBody,
                        503: ErrorBody,
                    },
                },
            },
            async (request, reply) => {
                const body = Buffer.isBuffer(request.body)
                    ? request.body
                    : Buffer.from(String(request.body), 'utf8');
                const stored = await storeOutput(
                    deps,
                    request.params.taskId,
                    request.params.name,
                    body,
                );
                switch (stored.outcome) {
                    // The address and digest are this service's: what a success is held to.
                    case 'stored':
                        return reply.send(stored.artifact);
                    case 'missing':
                        return reply
                            .code(404)
                            .send({ code: 'not_found', message: 'no such build' });
                    case 'unclaimed':
                        return reply.code(409).send(UNCLAIMED);
                    case 'unattached':
                        return unattached(reply, 'games bucket');
                    case 'unavailable':
                        return reply.code(502).send({
                            code: 'internal',
                            message: 'the build output could not be stored',
                        });
                }
            },
        );
    };
}
