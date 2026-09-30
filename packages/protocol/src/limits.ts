// A cap both endpoints must hold the same number for: the sender sizes its frames to it and the
// receiver refuses one past it, so two copies would drift into a sender the receiver rejects.

/** Requests one `request` frame may carry; a sender holds the rest, a receiver refuses more. */
export const MAX_REQUESTS_PER_FRAME = 16;
