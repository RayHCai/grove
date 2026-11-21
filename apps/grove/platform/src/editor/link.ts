import { configuredUrl } from '@grove/ui';

/** Where the editor is, which a build is told and a dev server defaults for. */
export function editorUrl(): string {
    return configuredUrl(
        'VITE_EDITOR_URL',
        import.meta.env.VITE_EDITOR_URL,
        'http://localhost:5176',
        import.meta.env.DEV,
    );
}

function parseUrl(raw: string, base: string): URL | undefined {
    try {
        return new URL(raw, base);
    } catch {
        return undefined;
    }
}

/**
 * The return address the editor sent, but only where it is one this platform may send somebody to.
 *
 * Honouring whatever `return=` carried would be an open redirect: a link written by anybody could
 * bounce a creator off this origin onto a page dressed as it. Same origin as the editor or nothing
 * (and nothing is not a failure, it is the editor's front door).
 */
export function returnToEditor(raw: string | undefined): string | undefined {
    if (raw === undefined) return undefined;
    const editor = parseUrl(editorUrl(), editorUrl());
    const asked = parseUrl(raw, editorUrl());
    if (editor === undefined || asked === undefined) return undefined;
    return asked.origin === editor.origin ? asked.toString() : undefined;
}

/** The query parameter the editor reads the game to open from; it names one, and grants nothing. */
export const GAME_PARAM = 'game';

/** Where a crossing to the editor lands: back where it sent somebody from, or on one game. */
export interface EditorTarget {
    gameId?: string | undefined;
    returnTo?: string | undefined;
}

/**
 * The editor, and at most the game to open on the URL.
 *
 * Nothing of the session travels here. The API set the cookie on its own origin and the editor is a
 * subdomain of this same site, so the browser carries it across by itself; this is a destination,
 * not a credential, and there is nothing on it to leak into a history or a `Referer`.
 */
export function editorLink({ gameId, returnTo }: EditorTarget = {}): string {
    const back = returnToEditor(returnTo);
    if (back !== undefined) return back;
    const url = new URL('/', editorUrl());
    if (gameId !== undefined) url.searchParams.set(GAME_PARAM, gameId);
    return url.toString();
}
