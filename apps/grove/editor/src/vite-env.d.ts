/// <reference types="vite/client" />

interface ImportMetaEnv {
    /** `true` to show, in a build, what is drawn but not wired to anything yet. */
    readonly VITE_SHOW_UNFINISHED?: string;
    /** Where `@grove/api` is. */
    readonly VITE_API_URL?: string;
    /** Where the platform is, which signs somebody in and looks after their account. */
    readonly VITE_PLATFORM_URL?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
