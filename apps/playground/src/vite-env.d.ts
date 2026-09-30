/// <reference types="vite/client" />

interface ImportMetaEnv {
    /** Where the game server is; the page's own host on the game port when unset. */
    readonly VITE_GAME_URL?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
