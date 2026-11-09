// A cap both endpoints must hold the same number for: the sender sizes its frames to it and the
// receiver refuses one past it, so two copies would drift into a sender the receiver rejects.

/** Requests one `request` frame may carry; a sender holds the rest, a receiver refuses more. */
export const MAX_REQUESTS_PER_FRAME = 16;

/** Actions one input frame may carry, so one frame cannot buy an unbounded dispatch. */
export const MAX_ACTIONS_PER_FRAME = 32;

/** Longest accepted action name; it becomes a key in core's fold and a dispatched event name. */
export const MAX_ACTION_NAME_LENGTH = 64;

/** Interactions one frame may carry, so a single frame cannot buy an unbounded dispatch walk. */
export const MAX_INTERACTIONS_PER_FRAME = 16;

/** Longest accepted widget or screen name; each becomes the event name of a dispatch. */
export const MAX_WIDGET_NAME_LENGTH = 64;

/** Longest accepted request name; it becomes the event name of that dispatch. */
export const MAX_REQUEST_NAME_LENGTH = 64;

/** Values one request payload may hold, over the whole graph: it bounds nesting and count. */
export const MAX_REQUEST_PAYLOAD_NODES = 256;

/** Longest accepted identity string; a hex digest and a panel id both sit far under this. */
export const MAX_IDENTITY_LENGTH = 128;
