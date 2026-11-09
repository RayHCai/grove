/// <reference types="vite/client" />

interface ImportMetaEnv {
    /** Where a refused join sends somebody back to. */
    readonly VITE_PLATFORM_URL?: string;
    /** The hosts a join's server may sit at or under, comma-separated. */
    readonly VITE_GAME_HOSTS?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
