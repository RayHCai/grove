// What the fleet seam puts on the wire, and what it makes of each answer that comes back.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    GameId,
    HostId,
    InstanceId,
    PlacementRequest,
    PlayerId,
    REQUEST_ID_HEADER,
    SessionId,
} from '@grove/api-contract';
import { readEnv } from '../src/env.js';
import { httpFleet, unattachedFleet } from '../src/fleet.js';

const PLAYER = PlayerId.parse('f47ac10b-58cc-4372-a567-0e02b2c3d479');
const GAME_ID = GameId.parse('9f1c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f');
const SESSION_ID = SessionId.parse('5d9a0c3b-7e21-4f44-9b0d-3c5e7a9f1b24');
const SERVER_URL = `wss://box.example/v1/instances/${SESSION_ID}`;
const BEARER = 'c'.repeat(32);
const REQUEST_ID = 'a-caller-presented-id';

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

const PLACEMENT = {
    hostId: HostId.parse('1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'),
    instanceId: InstanceId.parse('6f5e4d3c-2b1a-4f9e-8d7c-6b5a4f3e2d1c'),
    sessionId: SESSION_ID,
    serverUrl: SERVER_URL,
};

interface Sent {
    url: string;
    init: RequestInit;
}

/** Stands in for the router and keeps what was sent to it, in the order it was sent. */
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

describe('the fleet seam with nothing behind it', () => {
    it('reports no box rather than a failure', async () => {
        expect(await unattachedFleet.place(GAME_ID, PLAYER, REQUEST_ID)).toBeUndefined();
    });
});

describe('the fleet seam over http', () => {
    it('asks the router for a placement, under the bearer its gate compares', async () => {
        const sent = stubFetch(json(PLACEMENT, 200));

        expect(await httpFleet(env).place(GAME_ID, PLAYER, REQUEST_ID)).toEqual({
            sessionId: SESSION_ID,
            serverUrl: SERVER_URL,
        });

        expect(sent).toHaveLength(1);
        expect(sent[0]?.url).toBe('http://server-manager.grove.internal:4003/v1/placements');
        expect(sent[0]?.init.method).toBe('POST');
        expect(sent[0]?.init.headers).toMatchObject({ authorization: `Bearer ${BEARER}` });
        expect(PlacementRequest.parse(JSON.parse(String(sent[0]?.init.body)))).toEqual({
            gameId: GAME_ID,
            playerId: PLAYER,
        });
    });

    it('names the join it is placing, so the router logs it under the id the player got', async () => {
        const sent = stubFetch(json(PLACEMENT, 200));

        await httpFleet(env).place(GAME_ID, PLAYER, REQUEST_ID);

        expect(sent[0]?.init.headers).toMatchObject({ [REQUEST_ID_HEADER]: REQUEST_ID });
    });

    it('reads a conflict as the fleet being full', async () => {
        stubFetch(json({ code: 'conflict', message: 'no capacity' }, 409));
        expect(await httpFleet(env).place(GAME_ID, PLAYER, REQUEST_ID)).toBeUndefined();
    });

    it('refuses to read a broken router as a full one', async () => {
        stubFetch(json({ code: 'internal', message: 'internal error' }, 503));
        await expect(httpFleet(env).place(GAME_ID, PLAYER, REQUEST_ID)).rejects.toThrow(/503/u);
    });
});
