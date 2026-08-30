// How this app is SERVED, which is the one thing neither the game nor its project file describes.
//
// Everything a creator tunes is in `scripts/globals.ts`; everything the world is made of is in
// `project.ts`. What is left is the address a browser dials, and both halves need it — so this is
// the one file outside `scripts/` that both compilers include.

/** Where the game server listens, and what a browser dials when nothing overrides it. */
export const DEFAULT_GAME_PORT = 5174;

export function defaultGameUrl(hostname: string): string {
    return `ws://${hostname}:${DEFAULT_GAME_PORT}`;
}
