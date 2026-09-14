// Where an upload goes, what names it there, and what each answer from the far side is read as.

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BuildJobId, BuildRequest, GameId, REQUEST_ID_HEADER } from '@grove/api-contract';
import { httpBuilder, unattachedBuilder } from '../src/builder.js';
import { readEnv } from '../src/env.js';

const GAME_ID = GameId.parse('9f1c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f');
const JOB_ID = BuildJobId.parse('8c2e4a60-5d17-4b93-8f0a-1e6d2c4b7a35');
const BEARER = 'c'.repeat(32);
const REQUEST_ID = 'a-caller-presented-id';
const SOURCE = Buffer.from('PK a creator project');
const SOURCE_HASH = createHash('sha256').update(SOURCE).digest('hex');

const env = readEnv({
    NODE_ENV: 'test',
    SESSION_SECRET: 'a'.repeat(32),
    GAME_TOKEN_SECRET: 'b'.repeat(32),
    FLEET_SECRET: BEARER,
    TRUSTED_PROXIES: 'loopback',
    PLATFORM_ORIGIN: 'https://grove.example',
    EDITOR_ORIGIN: 'https://editor.grove.example',
    SERVER_MANAGER_URL: 'http://server-manager.grove.internal:4003',
    UPLOAD_SERVICE_URL: 'http://upload-service.grove.internal:4005',
    GAME_BUILDER_URL: 'http://game-builder.grove.internal:4002',
});

const JOB = {
    jobId: JOB_ID,
    gameId: GAME_ID,
    state: 'queued',
    queuedAt: '2026-09-13T12:00:00.000Z',
    diagnostics: [],
};

interface Sent {
    url: string;
    init: RequestInit;
}

/** Stands in for the two services and keeps what was sent to them, in the order it was sent. */
function stubFetch(...answers: Response[]): Sent[] {
    const sent: Sent[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        sent.push({ url, init });
        return answers[sent.length - 1];
    });
    return sent;
}

function json(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('the build seam with nothing behind it', () => {
    it('names itself rather than minting a job id', async () => {
        expect(await unattachedBuilder.queue(GAME_ID, SOURCE, REQUEST_ID)).toEqual({
            outcome: 'unattached',
        });
    });
});

describe('the build seam over http', () => {
    it('stores the source under its own hash and queues a build that names it', async () => {
        const sent = stubFetch(new Response(null, { status: 201 }), json(JOB, 202));

        expect(await httpBuilder(env).queue(GAME_ID, SOURCE, REQUEST_ID)).toEqual({
            outcome: 'queued',
            jobId: JOB_ID,
        });

        expect(sent).toHaveLength(2);
        expect(sent[0]?.url).toBe(
            `http://upload-service.grove.internal:4005/v1/objects/${SOURCE_HASH}`,
        );
        expect(sent[0]?.init.method).toBe('PUT');
        expect(sent[0]?.init.headers).toMatchObject({ authorization: `Bearer ${BEARER}` });
        expect(sent[0]?.init.body).toEqual(SOURCE);

        expect(sent[1]?.url).toBe('http://game-builder.grove.internal:4002/v1/builds');
        expect(sent[1]?.init.headers).toMatchObject({ authorization: `Bearer ${BEARER}` });
        expect(BuildRequest.parse(JSON.parse(String(sent[1]?.init.body)))).toEqual({
            gameId: GAME_ID,
            sourceHash: SOURCE_HASH,
        });
    });

    it('names both calls, so a publish is one id across the three services it crosses', async () => {
        const sent = stubFetch(new Response(null, { status: 201 }), json(JOB, 202));

        await httpBuilder(env).queue(GAME_ID, SOURCE, REQUEST_ID);

        expect(sent[0]?.init.headers).toMatchObject({ [REQUEST_ID_HEADER]: REQUEST_ID });
        expect(sent[1]?.init.headers).toMatchObject({ [REQUEST_ID_HEADER]: REQUEST_ID });
    });

    it('takes an object already stored as stored', async () => {
        stubFetch(new Response(null, { status: 200 }), json(JOB, 202));
        expect(await httpBuilder(env).queue(GAME_ID, SOURCE, REQUEST_ID)).toEqual({
            outcome: 'queued',
            jobId: JOB_ID,
        });
    });

    it('asks for no build of a source that was not stored', async () => {
        const sent = stubFetch(json({ code: 'internal', message: 'internal error' }, 500));
        expect(await httpBuilder(env).queue(GAME_ID, SOURCE, REQUEST_ID)).toEqual({
            outcome: 'unavailable',
        });
        expect(sent).toHaveLength(1);
    });

    it('keeps the builder ration a ration', async () => {
        stubFetch(
            new Response(null, { status: 201 }),
            json({ code: 'rate_limited', message: 'too many builds for this game' }, 429),
        );
        expect(await httpBuilder(env).queue(GAME_ID, SOURCE, REQUEST_ID)).toEqual({
            outcome: 'rate_limited',
        });
    });

    it('reports a builder that refused the build', async () => {
        stubFetch(
            new Response(null, { status: 201 }),
            json({ code: 'internal', message: 'internal error' }, 500),
        );
        expect(await httpBuilder(env).queue(GAME_ID, SOURCE, REQUEST_ID)).toEqual({
            outcome: 'unavailable',
        });
    });
});
