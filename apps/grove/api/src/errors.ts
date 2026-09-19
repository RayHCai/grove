import type { FastifyError, FastifyInstance } from 'fastify';
import type { ErrorBody } from '@grove/api-contract';
import {
    hasZodFastifySchemaValidationErrors,
    isResponseSerializationError,
} from 'fastify-type-provider-zod';

// An error a plugin raised carries a status and no code, and collapsing every one of them into
// `invalid_request` is what would leave a caller reading the status anyway.
const CODE_BY_STATUS: ReadonlyMap<number, ErrorBody['code']> = new Map([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [429, 'rate_limited'],
]);

/**
 * One shape for every failure, so a caller branches on `code` rather than guessing from a status.
 * A response that failed to serialize is a 500, not a 400: the request was fine.
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
            code: status >= 500 ? 'internal' : (CODE_BY_STATUS.get(status) ?? 'invalid_request'),
            message: status >= 500 ? 'internal error' : error.message,
        });
    });

    app.setNotFoundHandler((_request, reply) =>
        reply.code(404).send({ code: 'not_found', message: 'no such route' }),
    );
}
