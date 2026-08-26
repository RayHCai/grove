/**
 * Server-minted entity identity, opaque to the client — numerically the server's own `EntityId`,
 * cast at the send boundary.
 *
 * Branded because two runtimes that reached the same logical world through different histories mint
 * DIFFERENT handles for the same entity, so shipping a local handle is a correctness bug rather
 * than a naming preference. The brand key is its own `unique symbol`, which makes a `NetId`
 * mutually unassignable with core's `EntityId` rather than merely distinct in intent.
 */
export type NetId = number & { readonly __netId: unique symbol };

/**
 * A player's wire identity. Unbranded, unlike {@link NetId}: the server mints it as a string both
 * ends carry verbatim, so there is no local-handle confusion to prevent — the alias exists so the
 * five fields that hold one say so, rather than reading as unrelated strings.
 */
export type PlayerId = string;

/**
 * Which project a session is playing. Unbranded for {@link PlayerId}'s reason: the panel mints it
 * and both ends carry it verbatim, so there is no local handle to confuse it with.
 */
export type ProjectId = string;
