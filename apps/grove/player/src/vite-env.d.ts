/// <reference types="vite/client" />

interface ImportMetaEnv {
    /** Where a refused join sends somebody back to. */
    readonly VITE_PLATFORM_URL?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
