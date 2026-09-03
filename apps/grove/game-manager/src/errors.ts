import type { FastifyError, FastifyInstance } from 'fastify';
import {
    hasZodFastifySchemaValidationErrors,
    isResponseSerializationError,
} from 'fastify-type-provider-zod';

/** The same failure shape `@grove/api` returns, so one client parser covers both services. */
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
