/**
 * Server-minted entity identity, opaque to the client — the server's `EntityId` at the boundary.
 * Branded: two runtimes mint different handles for one entity, so shipping a local one is a bug.
 */
export type NetId = number & { readonly __netId: unique symbol };

/** A player's wire identity. Unbranded: both ends carry the server's string verbatim. */
export type PlayerId = string;

/**
 * Which project a session is playing. Unbranded for {@link PlayerId}'s reason: the panel mints it
 * and both ends carry it verbatim, so there is no local handle to confuse it with.
 */
export type ProjectId = string;
