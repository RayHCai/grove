// The fixtures every suite below drives the editor with: a service that answers out of memory, and
// the project the template opens as.

import { AssetUploadRequest, MAX_ASSET_BYTES, WorkspaceSave } from '@grove/api-contract';
import type {
    Account,
    AssetUpload,
    ErrorBody,
    Game,
    GameId,
    PlayerId,
    VersionId,
    Workspace,
    WorkspaceFile,
    WorkspacePath,
} from '@grove/api-contract';
import { PROJECT_FORMAT_VERSION } from '@platform/project';
import type { ProjectManifest } from '@platform/project';
import type { Api } from '../src/api/client';
import { KEEPALIVE_BYTES, createApi } from '../src/api/client';
import { asProjectFile, treeOf } from '../src/project/files';
import type { ProjectFile, ProjectNode } from '../src/project/files';
import { projectDraft } from '../src/project/manifest';
import { scanScripts } from '../src/project/scripts';
import { bytesOf, draftFromText, isText } from '../src/workspace/files';
import type { DraftFile } from '../src/workspace/files';
import type { OpenGame } from '../src/workspace/session';
import { DEFAULT_TEMPLATE } from '../src/workspace/templates';

export const PLAYER_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479' as PlayerId;
export const GAME_ID = '9f1c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f' as GameId;

/** Where the fake service and its bucket answer, which nothing outside these suites dials. */
export const API_URL = 'https://api.grove.example';
export const BUCKET_URL = 'https://bucket.grove.example';

export const ACCOUNT: Account = {
    playerId: PLAYER_ID,
    email: 'creator@grove.example',
    displayName: 'Rowan',
    createdAt: '2026-09-01T09:00:00.000Z',
};

export const GAME: Game = {
    gameId: GAME_ID,
    ownerId: PLAYER_ID,
    title: "Pip's Garden",
    visibility: 'private',
    createdAt: '2026-09-01T09:00:00.000Z',
    publishedAt: null,
};

/** The file the default template opens on, which most of these suites type into. */
export const TEMPLATE_PATH = DEFAULT_TEMPLATE.openPath;

/** The default template's manifest, stamped by hand so a suite builds an opened game synchronously. */
export const PROJECT: ProjectManifest = {
    ...DEFAULT_TEMPLATE.project,
    formatVersion: PROJECT_FORMAT_VERSION,
    projectId: GAME_ID,
    contentHash: 'a-fixture-hash',
    scriptModules: scanScripts(
        DEFAULT_TEMPLATE.files().flatMap((file) =>
            file.text === undefined ? [] : [{ path: file.path, text: file.text }],
        ),
    ).modules,
};

/** What a game seeded from the default template holds: its sources, and the manifest beside them. */
export function templateDrafts(): DraftFile[] {
    return [...DEFAULT_TEMPLATE.files(), projectDraft(PROJECT)];
}

/** A game that is plain TypeScript: no script class, and so nothing for a world to instantiate. */
export const PLAIN_PROJECT: ProjectManifest = {
    ...PROJECT,
    templates: [],
    gameScripts: [],
    scriptModules: [],
};

/** A few files across two folders: its own set, so a suite about order survives a template change. */
export function sampleFiles(): DraftFile[] {
    return [
        draftFromText('src/main.ts', 'export const start = 1;\n'),
        draftFromText('src/sprout.ts', 'export const grow = 2;\n'),
        draftFromText('src/garden.ts', 'export const plot = 3;\n'),
        draftFromText('hud/hud.ts', 'export const draw = 4;\n'),
        draftFromText('game.config.ts', 'export const config = {};\n'),
    ];
}

export function project(files: readonly DraftFile[] = sampleFiles()): ProjectFile[] {
    return files.map(asProjectFile);
}

export function projectTree(files?: readonly DraftFile[]): ProjectNode[] {
    return treeOf(project(files));
}

export function fileAt(path: string): ProjectFile {
    const found = project().find((file) => file.path === path);
    if (found === undefined) throw new Error(`${path} is not in the sample`);
    return found;
}

/** A game already open, as the boot sequence would have handed it over. */
export function opened(over: Partial<OpenGame> = {}): OpenGame {
    return {
        account: ACCOUNT,
        game: GAME,
        revision: 0,
        saved: [],
        files: templateDrafts(),
        project: PROJECT,
        openPath: DEFAULT_TEMPLATE.openPath,
        seeded: true,
        ...over,
    };
}

interface Stored {
    bytes: Uint8Array;
    type: string;
}

export interface FakeApi extends Api {
    /** Every key a save recorded, by the path the editor put it at. */
    readonly bucket: Map<string, Stored>;
    /** Bytes waiting under `uploads/` for a save to name them. */
    readonly uploads: Map<string, Stored>;
    /** Every presign handed out, whether or not the bytes ever followed. */
    readonly signed: WorkspacePath[];
    /** Every save the service took, the keepalive ones included. */
    readonly saves: WorkspaceSave[];
    /** Every request that reached the service or the bucket, as `METHOD url`. */
    readonly requests: string[];
    workspaceState: Workspace;
    owned: Game[];
    /** Whether the cookie the browser carries names a live session. */
    signedIn: boolean;
    /** The token the live session verifies writes against. */
    readonly csrfToken: string;
    /** A sign-in on another tab: a fresh session, so every token handed out before it is stale. */
    signInElsewhere(): void;
}

// The service and its bucket out of memory, behind the editor's own client, refusing as the real
// ones do: a stale base, an unsent asset, no cookie, a stale token, a PUT its presign did not sign.
export function fakeApi(over: Partial<FakeApi> = {}): FakeApi {
    let minted = 0;
    let sessions = 1;
    const version = (): VersionId => {
        minted += 1;
        return `v${String(minted)}` as VersionId;
    };
    const presigns = new Map<string, { contentType: string; byteLength: number }>();

    const state = {
        bucket: new Map<string, Stored>(),
        uploads: new Map<string, Stored>(),
        signed: [] as WorkspacePath[],
        saves: [] as WorkspaceSave[],
        requests: [] as string[],
        signedIn: true,
        owned: [GAME],
        workspaceState: {
            gameId: GAME_ID,
            revision: 0,
            files: [],
            updatedAt: '2026-09-16T09:00:00.000Z',
        } as Workspace,
        csrfToken: 'token-1',
        signInElsewhere: () => {
            sessions += 1;
            state.signedIn = true;
            state.csrfToken = `token-${String(sessions)}`;
        },
    };

    function apply(save: WorkspaceSave): Response {
        if (save.baseRevision !== state.workspaceState.revision) {
            return refuse(409, 'conflict', 'the workspace is at a later revision');
        }
        const absent = save.assets.filter((path) => !state.uploads.has(path));
        if (absent.length > 0) {
            return refuse(400, 'invalid_request', `never uploaded: ${absent.join(', ')}`);
        }

        const written: WorkspaceFile[] = [];
        for (const source of save.sources) {
            const bytes = new TextEncoder().encode(source.text);
            state.bucket.set(source.path, { bytes, type: source.contentType });
            written.push({
                path: source.path,
                kind: 'source',
                versionId: version(),
                byteLength: bytes.byteLength,
                contentType: source.contentType,
            });
        }
        for (const path of save.assets) {
            const held = state.uploads.get(path) as Stored;
            state.uploads.delete(path);
            state.bucket.set(path, held);
            written.push({
                path,
                kind: 'asset',
                versionId: version(),
                byteLength: held.bytes.byteLength,
                contentType: held.type,
            });
        }
        for (const path of save.deletes) state.bucket.delete(path);

        const kept = state.workspaceState.files.filter(
            (file) =>
                !save.deletes.includes(file.path) &&
                !written.some((each) => each.path === file.path),
        );
        state.saves.push(save);
        state.workspaceState = {
            ...state.workspaceState,
            revision: save.baseRevision + 1,
            files: [...kept, ...written].toSorted((left, right) =>
                left.path < right.path ? -1 : 1,
            ),
        };
        return json(state.workspaceState);
    }

    function service(method: string, path: string, body: unknown): Response {
        if (method === 'GET' && path === '/v1/auth/session') {
            return state.signedIn
                ? json({ playerId: PLAYER_ID, csrfToken: state.csrfToken })
                : refuse(401, 'unauthorized', 'sign in first');
        }
        if (method === 'GET' && path === '/v1/players/me') return json(ACCOUNT);
        if (method === 'GET' && path === '/v1/games') return json(state.owned);
        if (method === 'POST' && path === '/v1/games') {
            const made = { ...GAME, title: (body as { title: string }).title };
            state.owned = [made];
            return json(made, 201);
        }
        const game = /^\/v1\/games\/([^/]+)\/(workspace|assets|files\/(.+))$/u.exec(path);
        if (game?.[1] !== GAME_ID) return refuse(404, 'not_found', 'no such route');
        if (game[2] === 'workspace' && method === 'GET') return json(state.workspaceState);
        if (game[2] === 'workspace' && method === 'PUT') {
            const save = WorkspaceSave.safeParse(body);
            return save.success ? apply(save.data) : refuse(400, 'invalid_request', 'not a save');
        }
        if (game[2] === 'assets' && method === 'POST') {
            if ((body as { byteLength?: number }).byteLength! > MAX_ASSET_BYTES) {
                return refuse(413, 'invalid_request', 'that asset is larger than an asset may be');
            }
            const asked = AssetUploadRequest.safeParse(body);
            if (!asked.success) return refuse(400, 'invalid_request', 'not an upload request');
            state.signed.push(asked.data.path);
            presigns.set(asked.data.path, asked.data);
            const ticket: AssetUpload = {
                path: asked.data.path,
                url: `${BUCKET_URL}/${GAME_ID}/uploads/${asked.data.path}?X-Amz-Signature=fake`,
                expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
                maxBytes: MAX_ASSET_BYTES,
                headers: { 'content-type': asked.data.contentType },
            };
            return json(ticket);
        }
        if (game[3] !== undefined && method === 'GET') {
            const held = state.bucket.get(game[3]);
            return held === undefined
                ? refuse(404, 'not_found', 'no such file')
                : new Response(new Uint8Array(held.bytes));
        }
        return refuse(404, 'not_found', 'no such route');
    }

    /** The presigned PUT, which is signed for one type and one length and carries no cookie. */
    function bucketPut(url: URL, init: RequestInit): Response {
        const path = url.pathname.slice(`/${GAME_ID}/uploads/`.length);
        const signed = presigns.get(path);
        const headers = new Headers(init.headers);
        const bytes = init.body as Uint8Array;
        if (
            init.credentials === 'include' ||
            signed === undefined ||
            headers.get('content-type') !== signed.contentType ||
            bytes.byteLength !== signed.byteLength
        ) {
            return new Response('<Error><Code>SignatureDoesNotMatch</Code></Error>', {
                status: 403,
            });
        }
        state.uploads.set(path, { bytes: new Uint8Array(bytes), type: signed.contentType });
        return new Response(null, { status: 200 });
    }

    const fetch = async (
        input: string | URL | Request,
        init: RequestInit = {},
    ): Promise<Response> => {
        const url = new URL(String(input));
        const method = init.method ?? 'GET';
        state.requests.push(`${method} ${url.href}`);
        if (url.origin === BUCKET_URL)
            return method === 'PUT' ? bucketPut(url, init) : refuse(405, 'invalid_request', 'no');
        if (url.origin !== API_URL) throw new TypeError('Failed to fetch');
        // The browser drops a keepalive body over its ceiling before anything is sent.
        if (
            init.keepalive === true &&
            new TextEncoder().encode(String(init.body ?? '')).byteLength > KEEPALIVE_BYTES
        ) {
            throw new TypeError('Failed to execute fetch: keepalive body too large');
        }
        // Without the cookie the API is a stranger, which is what a call missing `include` is.
        const session = init.credentials === 'include' && state.signedIn;
        const anonymous = method === 'GET' && url.pathname === '/v1/auth/session';
        if (!session && !anonymous) return refuse(401, 'unauthorized', 'sign in first');
        if (!anonymous && !['GET', 'HEAD'].includes(method)) {
            const token = new Headers(init.headers).get('x-csrf-token');
            if (token !== state.csrfToken) return refuse(403, 'csrf_invalid', 'Invalid csrf token');
        }
        const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
        return service(method, url.pathname, body);
    };

    return Object.assign(state, createApi({ baseUrl: API_URL, fetch }), over) as FakeApi;
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function refuse(status: number, code: ErrorBody['code'], message: string): Response {
    return json({ code, message }, status);
}

/** A workspace already holding these files, with their bytes in the bucket beside them. */
export async function stored(
    api: FakeApi,
    files: readonly DraftFile[],
    revision = 1,
): Promise<void> {
    let minted = 0;
    const saved: WorkspaceFile[] = [];
    for (const draft of files) {
        minted += 1;
        api.bucket.set(draft.path, { bytes: bytesOf(draft), type: draft.contentType });
        saved.push({
            path: draft.path as WorkspacePath,
            kind: isText(draft.contentType) ? 'source' : 'asset',
            versionId: `held-${String(minted)}` as VersionId,
            byteLength: bytesOf(draft).byteLength,
            contentType: draft.contentType,
        });
    }
    api.workspaceState = {
        ...api.workspaceState,
        revision,
        files: saved.toSorted((left, right) => (left.path < right.path ? -1 : 1)),
    };
}

/** An `AssetUpload` for a path, which a suite driving `putAsset` directly still needs one of. */
export function uploadTo(path: string, contentType = 'image/png'): AssetUpload {
    return {
        path: path as WorkspacePath,
        url: `${BUCKET_URL}/${GAME_ID}/uploads/${path}?X-Amz-Signature=fake`,
        expiresAt: '2026-09-16T10:15:00.000Z',
        maxBytes: MAX_ASSET_BYTES,
        headers: { 'content-type': contentType },
    };
}
