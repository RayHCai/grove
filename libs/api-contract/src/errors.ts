import { z } from 'zod';

/** Every failure both services return, so a caller branches on a code rather than a status. */
export const ErrorBody = z.object({
    code: z.enum([
        'unauthorized',
        'forbidden',
        'not_found',
        'conflict',
        // Apart from `forbidden`, because a stale token is fixed by re-reading the session.
        'csrf_invalid',
        'rate_limited',
        'invalid_request',
        'internal',
    ]),
    message: z.string(),
});

export type ErrorBody = z.infer<typeof ErrorBody>;
