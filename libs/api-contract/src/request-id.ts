/**
 * Where a service reads the correlation id it logs and forwards, and where it echoes the one it
 * chose. Lowercase because Node hands inbound header names down that way and `reply.header` does not
 * care, while `libs/go-grove/contract` spells the same header `X-Request-Id`.
 */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Wide enough for a uuid, a 32-hex trace id or a w3c traceparent, and narrow enough that a caller
 * cannot spend a megabyte of every log line on a header nobody bounded.
 */
export const REQUEST_ID_MAX_LENGTH = 64;

// Built from the bound rather than repeating it, since a pattern that disagreed with the constant
// would admit exactly the ids the constant exists to refuse.
const requestIdPattern = new RegExp(`^[0-9A-Za-z_-]{1,${String(REQUEST_ID_MAX_LENGTH)}}$`, 'u');

/**
 * Reports whether a presented id is one token a log, an echo header and an outbound call can all
 * carry unchanged. A caller sends this, so it is bounded before it is ever written down.
 */
export function validRequestId(candidate: string): boolean {
    return requestIdPattern.test(candidate);
}
