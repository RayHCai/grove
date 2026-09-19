import { ApiError } from './client';

/**
 * What a page puts on screen when a call did not go through.
 *
 * The service's own sentence is used where it wrote one, because it is the end that knows which
 * field was wrong. The two exceptions are the answers a person cannot act on: a rate limit, whose
 * message is a budget rather than an instruction, and anything the service did not name at all.
 */
export function messageOf(failure: unknown, fallback: string): string {
    if (!(failure instanceof ApiError)) return fallback;
    switch (failure.code) {
        case 'unreachable':
            return 'Grove could not be reached. Check your connection and try again.';
        case 'rate_limited':
            return 'Too many tries. Wait a minute and go again.';
        case 'internal':
            return fallback;
        default:
            return failure.message;
    }
}

/** Whether a refusal was the service saying nobody is signed in. */
export function isLapsedSession(failure: unknown): boolean {
    return failure instanceof ApiError && failure.code === 'unauthorized';
}
