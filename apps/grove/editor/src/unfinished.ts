/**
 * Whether to show what is drawn but not wired to anything yet.
 *
 * On in a dev server, and in a build told `VITE_SHOW_UNFINISHED=true`; off in every other build, so
 * nobody using Grove meets a control that does nothing or a page of made-up data.
 */
export const UNFINISHED = import.meta.env.DEV || import.meta.env.VITE_SHOW_UNFINISHED === 'true';
