import { messageOf } from '@grove/ui';
import { ApiError } from '../api/client';

/** The sentence a page shows when Play on `title` failed for any reason but a lapsed session. */
export function playRefusal(failure: unknown, title: string): string {
    // A conflict is the one refusal here that is about the game rather than the request: no
    // finished build, or no box with room for it.
    return failure instanceof ApiError && failure.status === 409
        ? `${title} cannot start right now: ${failure.message}.`
        : messageOf(failure, 'That game could not be started. Try again.');
}
