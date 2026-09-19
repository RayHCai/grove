// What the editor sends the service, and what it makes of each answer.

import { describe, expect, it, vi } from 'vitest';
import type { GameId, TaskId, WorkspacePath } from '@grove/api-contract';
import { ApiError, createApi } from '../src/api/client';

const BASE = 'http://localhost:4000';
const GAME = '9f1c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f' as GameId;
const TASK = '8c2e4a60-5d17-4b93-8f0a-1e6d2c4b7a35' as TaskId;
const TILE = 'art/tile.png' as WorkspacePath;
/** What a queued build comes back as, which is the whole of what a publish answers. */
const QUEUED = {
    taskId: TASK,
    gameId: GAME,
    kind: 'BUILD',
    status: 'NOT_STARTED',
    manifestRevision: 2,
    attempts: 0,
    createdAt: '2026-09-16T10:00:00.000Z',
    updatedAt: '2026-09-16T10:00:00.000Z',
};
const SIGNED_IN = {
    playerId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    csrfToken: 'a-minted-token',
};

interface Sent {
    url: string;
    init: RequestInit | undefined;
}

/** Answers each call in turn and keeps what was sent, the way the service would see it. */
function stub(...answers: Response[]): { sent: Sent[]; fetch: typeof globalThis.fetch } {
    const sent: Sent[] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
        sent.push({ url, init });
        return answers[sent.length - 1] ?? new Response(null, { status: 500 });
    }) as unknown as typeof globalThis.fetch;
    return { sent, fetch };
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function headerOf(sent: Sent | undefined, name: string): string | undefined {
    return (sent?.init?.headers as Record<string, string> | undefined)?.[name];
}

describe('every call', () => {
    it('sends the cookie, because the API is a different origin from this one', async () => {
        const { sent, fetch } = stub(json(SIGNED_IN));
        await createApi({ baseUrl: BASE, fetch }).session();
        expect(sent[0]?.init?.credentials).toBe('include');
        expect(sent[0]?.url).toBe(`${BASE}/v1/auth/session`);
    });

    it('carries the token the last sign-in handed out, and only once there is one', async () => {
        const { sent, fetch } = stub(json([]), json(SIGNED_IN), json([]));
        const api = createApi({ baseUrl: BASE, fetch });

        await api.games();
        expect(headerOf(sent[0], 'x-csrf-token')).toBeUndefined();

        await api.session();
        await api.games();
        expect(headerOf(sent[2], 'x-csrf-token')).toBe('a-minted-token');
    });

    it('reads the service’s own refusal rather than guessing from the status', async () => {
        const { fetch } = stub(json({ code: 'conflict', message: 'the workspace moved on' }, 409));
        const failed = await createApi({ baseUrl: BASE, fetch })
            .save(GAME, { baseRevision: 1, sources: [], assets: [], deletes: [] })
            .catch((error: unknown) => error);

        expect(failed).toBeInstanceOf(ApiError);
        expect((failed as ApiError).code).toBe('conflict');
        expect((failed as ApiError).status).toBe(409);
        expect((failed as ApiError).message).toBe('the workspace moved on');
    });

    it('names a body that was not a refusal after its status', async () => {
        const { fetch } = stub(new Response('<html>502</html>', { status: 502 }));
        const failed = await createApi({ baseUrl: BASE, fetch })
            .games()
            .catch((error: unknown) => error);
        expect((failed as ApiError).message).toBe('the API answered 502');
    });

    it('tells a service that could not be reached apart from one that refused', async () => {
        const fetch = vi.fn(async () => {
            throw new TypeError('failed to fetch');
        }) as unknown as typeof globalThis.fetch;
        const failed = await createApi({ baseUrl: BASE, fetch })
            .games()
            .catch((error: unknown) => error);
        expect((failed as ApiError).code).toBe('unreachable');
        expect((failed as ApiError).status).toBe(0);
    });
});

describe('the session', () => {
    it('is nothing at all when the cookie names nobody, which is the ordinary first load', async () => {
        const { fetch } = stub(new Response(null, { status: 401 }));
        expect(await createApi({ baseUrl: BASE, fetch }).session()).toBeUndefined();
    });

    it('is the one read that keeps the token, so a browser holding the cookie can write', async () => {
        const { sent, fetch } = stub(json(SIGNED_IN), json([]));
        const api = createApi({ baseUrl: BASE, fetch });
        await api.session();
        await api.games();
        expect(headerOf(sent[1], 'x-csrf-token')).toBe('a-minted-token');
    });

    it('forgets the token when it ends, so nothing rides the session that is gone', async () => {
        const { sent, fetch } = stub(
            json(SIGNED_IN),
            new Response(null, { status: 204 }),
            json([]),
        );
        const api = createApi({ baseUrl: BASE, fetch });
        await api.session();
        await api.signOut();
        await api.games();
        expect(headerOf(sent[2], 'x-csrf-token')).toBeUndefined();
    });
});

describe('a file', () => {
    it('is read by path, at the version the saved set names', async () => {
        const { sent, fetch } = stub(new Response(new Uint8Array([0, 159, 146, 150])));
        const read = await createApi({ baseUrl: BASE, fetch }).file(GAME, TILE);

        expect(sent[0]?.url).toBe(`${BASE}/v1/games/${GAME}/files/${TILE}`);
        expect([...read]).toEqual([0, 159, 146, 150]);
    });
});

describe('an asset', () => {
    const TICKET = {
        path: TILE,
        url: 'https://games.example/upload?X-Amz-Signature=fake',
        expiresAt: '2026-09-16T10:15:00.000Z',
        maxBytes: 32 * 1024 * 1024,
    };

    it('asks the API where its bytes go, and nothing more', async () => {
        const { sent, fetch } = stub(json(TICKET));
        const upload = await createApi({ baseUrl: BASE, fetch }).assetUpload(
            GAME,
            TILE,
            'image/png',
        );

        expect(sent[0]?.url).toBe(`${BASE}/v1/games/${GAME}/assets`);
        expect(sent[0]?.init?.method).toBe('POST');
        expect(upload.url).toBe(TICKET.url);
    });

    it('goes straight to the bucket, carrying no session with it', async () => {
        const { sent, fetch } = stub(new Response(null, { status: 200 }));
        const bytes = new Uint8Array([137, 80, 78, 71]);
        await createApi({ baseUrl: BASE, fetch }).putAsset(TICKET, bytes, 'image/png');

        expect(sent[0]?.url).toBe(TICKET.url);
        expect(sent[0]?.init?.method).toBe('PUT');
        expect(headerOf(sent[0], 'content-type')).toBe('image/png');
        // A cookie sent here would be a credential handed to a third party.
        expect(sent[0]?.init?.credentials).toBeUndefined();
    });

    it('fails outright when the bucket refused, so no save names bytes that never landed', async () => {
        const { fetch } = stub(new Response(null, { status: 403 }));
        await expect(
            createApi({ baseUrl: BASE, fetch }).putAsset(TICKET, new Uint8Array([1]), 'image/png'),
        ).rejects.toBeInstanceOf(ApiError);
    });
});

describe('a publish', () => {
    it('carries no body: the manifest is already frozen, and this asks for a build of it', async () => {
        const { sent, fetch } = stub(json(QUEUED));
        const task = await createApi({ baseUrl: BASE, fetch }).publish(GAME);

        expect(sent[0]?.url).toBe(`${BASE}/v1/games/${GAME}/versions`);
        expect(sent[0]?.init?.body).toBeUndefined();
        expect(task.manifestRevision).toBe(2);
        expect(task.status).toBe('NOT_STARTED');
    });

    it('is watched through the game it belongs to', async () => {
        const { sent, fetch } = stub(json(QUEUED));
        await createApi({ baseUrl: BASE, fetch }).task(GAME, TASK);
        expect(sent[0]?.url).toBe(`${BASE}/v1/games/${GAME}/tasks/${TASK}`);
    });
});

describe('a save on the way out', () => {
    it('is keepalive, which is the whole of what makes it leave a closing tab', async () => {
        const { sent, fetch } = stub(new Response(null, { status: 200 }));
        await createApi({ baseUrl: BASE, fetch }).saveOnExit(GAME, {
            baseRevision: 3,
            sources: [],
            assets: [],
            deletes: [],
        });

        expect(sent[0]?.url).toBe(`${BASE}/v1/games/${GAME}/workspace`);
        expect(sent[0]?.init?.keepalive).toBe(true);
    });

    it('reports nothing, because there is nobody left to report it to', async () => {
        const fetch = vi.fn(async () => {
            throw new TypeError('failed to fetch');
        }) as unknown as typeof globalThis.fetch;
        await expect(
            createApi({ baseUrl: BASE, fetch }).saveOnExit(GAME, {
                baseRevision: 3,
                sources: [],
                assets: [],
                deletes: [],
            }),
        ).resolves.toBeUndefined();
    });
});
