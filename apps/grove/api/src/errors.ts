import type { FastifyError, FastifyInstance } from 'fastify';
import {
    hasZodFastifySchemaValidationErrors,
    isResponseSerializationError,
} from 'fastify-type-provider-zod';

/**
 * One shape for every failure, so a caller branches on `code` rather than guessing from a status.
 *
 * A response that failed to serialize is a 500, not a 400: the request was fine and the bug is
 * here, and returning the client's own fault for it sends callers looking in the wrong place.
 */
export function installErrorHandler(app: FastifyInstance): void {
    app.setErrorHandler((error: FastifyError, request, reply) => {
        if (hasZodFastifySchemaValidationErrors(error)) {
            return reply.code(400).send({
                code: 'invalid_request',
                message: error.validation.map((issue) => issue.message).join('; '),
            });
        }

        if (isResponseSerializationError(error)) {
            request.log.error({ err: error, route: error.method }, 'response did not match schema');
            return reply.code(500).send({ code: 'internal', message: 'internal error' });
        }

        const status = error.statusCode ?? 500;
        if (status >= 500) request.log.error({ err: error }, 'unhandled');

        return reply.code(status).send({
            code: status >= 500 ? 'internal' : 'invalid_request',
            message: status >= 500 ? 'internal error' : error.message,
        });
    });

    app.setNotFoundHandler((_request, reply) =>
        reply.code(404).send({ code: 'not_found', message: 'no such route' }),
    );
}
