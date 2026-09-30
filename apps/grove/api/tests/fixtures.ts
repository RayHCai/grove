// What every suite here starts from: one environment, the ids the cases name, and a sign-in.

import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { GameId, PlayerId, SessionId, TaskId } from '@grove/api-contract';
import { readEnv, type Env } from '../src/env.js';

export const CREATOR = PlayerId.parse('f47ac10b-58cc-4372-a567-0e02b2c3d479');
/** Somebody else, for the cases that turn on who owns what rather than on who is signed in. */
export const OTHER_PLAYER = PlayerId.parse('3e7a1b95-2c48-4d6f-8a01-5b9e7c3d2f46');
export const GAME_ID = GameId.parse('9f1c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f');
export const OTHER_GAME_ID = GameId.parse('2b6d4f8a-1c3e-4d5f-9a7b-6c8d0e2f4a1b');
export const SESSION_ID = SessionId.parse('5d9a0c3b-7e21-4f44-9b0d-3c5e7a9f1b24');
export const TASK_ID = TaskId.parse('8c2e4a60-5d17-4b93-8f0a-1e6d2c4b7a35');

export const FLEET_SECRET = 'c'.repeat(32);
export const CDN = 'https://cdn.grove.example';

/** Every variable the schema has no default for, at a value no test depends on. */
export const ENV_SOURCE = {
    NODE_ENV: 'test',
    SESSION_SECRET: 'a'.repeat(32),
    GAME_TOKEN_SECRET: 'b'.repeat(32),
    FLEET_SECRET,
    TRUSTED_PROXIES: 'loopback',
    GAMES_CDN_URL: CDN,
    PLATFORM_ORIGIN: 'https://grove.example',
    EDITOR_ORIGIN: 'https://editor.grove.example',
    SERVER_MANAGER_URL: 'http://server-manager.grove.internal:4003',
} as const;

export function testEnv(over: NodeJS.ProcessEnv = {}): Env {
    return readEnv({ ...ENV_SOURCE, ...over });
}

export interface Credentials {
    cookie: string;
    csrfToken: string;
}

/** The cookie and the token every later write has to carry, off a response that minted them. */
export function credentialsOf(response: {
    cookies: { name: string; value: string }[];
    json: () => unknown;
}): Credentials {
    const cookie = response.cookies.find((candidate) => candidate.name === 'sessionId');
    const body = response.json() as { csrfToken?: string };
    return { cookie: `sessionId=${cookie?.value ?? ''}`, csrfToken: body.csrfToken ?? '' };
}

/** Signs in, and hands back the two things every later write has to carry. */
export async function signIn(
    app: FastifyInstance,
    credentials: { email: string; password: string },
    headers: Record<string, string> = {},
): Promise<Credentials> {
    const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/sessions',
        headers,
        payload: credentials,
    });
    expect(response.statusCode).toBe(200);
    return credentialsOf(response);
}
