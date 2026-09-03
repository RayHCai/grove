/**
 * The wire contract this build speaks, stamped on `JoinRequest` and `Welcome` and compared on
 * receipt. A mismatch is a `Reject`, never a decode error.
 *
 * It lives here rather than in each endpoint because two hard-coded copies are exactly the drift
 * this package exists to end.
 */
export const PROTOCOL_VERSION = 3;
