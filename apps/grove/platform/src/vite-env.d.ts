/// <reference types="vite/client" />

interface ImportMetaEnv {
    /** `true` to show, in a build, what is drawn but not wired to anything yet. */
    readonly VITE_SHOW_UNFINISHED?: string;
    /** Where `@grove/api` is. */
    readonly VITE_API_URL?: string;
    /** Where `@grove/editor` is. */
    readonly VITE_EDITOR_URL?: string;
    /** Where `@grove/player-app` is, which a game's Play button sends the join to. */
    readonly VITE_PLAYER_URL?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
