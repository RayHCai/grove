// The address a browser dials, which neither the game nor its project file describes — and which
// both halves need, so this is the one file outside `scripts/` that both compilers include.

/** Where the game server listens, and what a browser dials when nothing overrides it. */
export const DEFAULT_GAME_PORT = 5174;

export function defaultGameUrl(hostname: string): string {
    return `ws://${hostname}:${DEFAULT_GAME_PORT}`;
}
