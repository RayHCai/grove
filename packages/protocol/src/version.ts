/**
 * The wire contract this build speaks, stamped on `JoinRequest` and `Welcome` and compared on
 * receipt. A mismatch is a `Reject`, never a decode error. Here, so no endpoint hard-codes a copy.
 */
export const PROTOCOL_VERSION = 3;
