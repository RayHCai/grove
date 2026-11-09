// The budgets a browser spends: a classroom behind one address is a budget per student, and the
// routes that take a credential are rationed per address and per account on top.

import { describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import {
    GameId,
    PlayerId,
    objectKey,
    type WorkspaceFile,
    type WorkspacePath,
} from '@grove/api-contract';
import { buildApp } from '../src/app.js';
import {
    CREDENTIAL_PER_ACCOUNT,
    CREDENTIAL_PER_ADDRESS,
    GENERAL_PER_MINUTE,
} from '../src/limits.js';
import { bucket, stores } from './doubles.js';
import { credentialsOf, testEnv } from './fixtures.js';

const SCHOOL = '198.51.100.7';
const CLASS_SIZE = 30;
/** Files in each student's game, every one read on open, as the editor does. */
const FILES = 40;
const PASSWORD = 'a long enough password';

const env = testEnv();

const uuid = (prefix: string, at: number) => `${prefix}${String(at).padStart(12, '0')}`;

/** A class of accounts, each owning one game of `FILES` files, over a bucket holding them all. */
async function classroom(): Promise<{ app: FastifyInstance; games: GameId[] }> {
    const students = Array.from({ length: CLASS_SIZE }, (_, at) => ({
        email: `student-${String(at)}@school.example`,
        player: PlayerId.parse(uuid('1111aaaa-0000-4000-8000-', at)),
        game: GameId.parse(uuid('2222bbbb-0000-4000-8000-', at)),
    }));
    const storage = bucket();
    const files = new Map<string, WorkspaceFile[]>();
    for (const student of students) {
        const held: WorkspaceFile[] = [];
        for (let at = 0; at < FILES; at += 1) {
            const path = `src/f${String(at)}.ts` as WorkspacePath;
            const written = await storage.put(
                objectKey(student.game, 'source', path),
                Buffer.from('x'),
                'text/typescript',
            );
            if (written.outcome !== 'written') throw new Error(written.outcome);
            held.push({
                path,
                kind: 'source',
                versionId: written.version.versionId,
                byteLength: 1,
                contentType: 'text/typescript',
            });
        }
        files.set(student.game, held);
    }

    const app = await buildApp(env, {
        ...stores({
            accounts: {
                signIn: async (email, password) =>
                    password === PASSWORD
                        ? students.find((s) => s.email === email)?.player
                        : undefined,
                accountOf: async (player) => ({
                    playerId: player,
                    email: 'student@school.example',
                    displayName: 'Student',
                    createdAt: '2026-11-08T08:00:00.000Z',
                }),
            },
            games: {
                ownerOf: async (game) => students.find((s) => s.game === game)?.player,
                gamesOf: async () => ({ games: [], next: undefined }),
            },
            workspaces: {
                workspaceOf: async (game) => ({
                    gameId: game,
                    revision: 1,
                    saveId: undefined,
                    files: files.get(game) ?? [],
                    updatedAt: '2026-11-08T08:00:00.000Z',
                }),
                fileOf: async (game, path) => {
                    const file = files.get(game)?.find((held) => held.path === path);
                    return file === undefined ? undefined : { ...file, edgeVersionId: undefined };
                },
            },
        }),
        storage,
    });
    return { app, games: students.map((student) => student.game) };
}

function from(app: FastifyInstance, request: InjectOptions): Promise<LightMyRequestResponse> {
    return app.inject({ ...request, remoteAddress: SCHOOL });
}

describe('a classroom behind one address', () => {
    it(`lets ${String(CLASS_SIZE)} students load, sign in and open their games within the minute`, async () => {
        const { app, games } = await classroom();
        const answers: number[] = [];

        await Promise.all(
            games.map(async (game, at) => {
                answers.push(
                    (await from(app, { method: 'GET', url: '/v1/auth/session' })).statusCode,
                );
                const signedIn = await from(app, {
                    method: 'POST',
                    url: '/v1/auth/sessions',
                    payload: { email: `student-${String(at)}@school.example`, password: PASSWORD },
                });
                answers.push(signedIn.statusCode);
                const { cookie } = credentialsOf(signedIn);
                for (const url of [
                    '/v1/auth/session',
                    '/v1/players/me',
                    '/v1/games',
                    `/v1/games/${game}/workspace`,
                ]) {
                    answers.push(
                        (await from(app, { method: 'GET', url, headers: { cookie } })).statusCode,
                    );
                }
                const reads = await Promise.all(
                    Array.from({ length: FILES }, (_, file) =>
                        from(app, {
                            method: 'GET',
                            url: `/v1/games/${game}/files/src/f${String(file)}.ts`,
                            headers: { cookie },
                        }),
                    ),
                );
                answers.push(...reads.map((read) => read.statusCode));
            }),
        );

        expect(answers.filter((status) => status === 429)).toEqual([]);
        expect(answers.filter((status) => status === 200)).toHaveLength(
            CLASS_SIZE * (1 + 4 + FILES),
        );
    });

    it('rations a signed-in session read and a sign-out on the general budget, not the credential one', async () => {
        const { app } = await classroom();
        const signedIn = await from(app, {
            method: 'POST',
            url: '/v1/auth/sessions',
            payload: { email: 'student-0@school.example', password: PASSWORD },
        });
        const { cookie, csrfToken } = credentialsOf(signedIn);
        const read = await from(app, {
            method: 'GET',
            url: '/v1/auth/session',
            headers: { cookie },
        });
        expect(Number(read.headers['x-ratelimit-limit'])).toBe(GENERAL_PER_MINUTE);
        const out = await from(app, {
            method: 'DELETE',
            url: '/v1/auth/sessions/current',
            headers: { cookie, 'x-csrf-token': csrfToken },
        });
        expect(out.statusCode).toBe(204);
        expect(Number(out.headers['x-ratelimit-limit'])).toBe(GENERAL_PER_MINUTE);
    });
});

describe('the credential budget', () => {
    it('stops one address guessing at one account, without stopping its neighbour', async () => {
        const { app } = await classroom();
        const guess = (email: string) =>
            from(app, {
                method: 'POST',
                url: '/v1/auth/sessions',
                payload: { email, password: 'wrong' },
            });
        for (let attempt = 0; attempt < CREDENTIAL_PER_ACCOUNT; attempt += 1) {
            expect((await guess('student-0@school.example')).statusCode).toBe(401);
        }
        const stopped = await guess('student-0@school.example');
        expect(stopped.statusCode).toBe(429);
        expect(stopped.json().code).toBe('rate_limited');
        expect((await guess('student-1@school.example')).statusCode).toBe(401);
    });

    it('stops one address past its ceiling, however many accounts it tries, across every credential route', async () => {
        const { app } = await classroom();
        for (let attempt = 0; attempt < CREDENTIAL_PER_ADDRESS; attempt += 1) {
            const answer = await from(app, {
                method: 'POST',
                url: '/v1/auth/sessions',
                payload: { email: `stranger-${String(attempt)}@school.example`, password: 'wrong' },
            });
            expect(answer.statusCode).toBe(401);
        }
        const signUp = await from(app, {
            method: 'POST',
            url: '/v1/players',
            payload: { email: 'new@school.example', password: PASSWORD, displayName: 'New' },
        });
        expect(signUp.statusCode).toBe(429);
        const reset = await from(app, {
            method: 'POST',
            url: '/v1/auth/password-resets',
            payload: { email: 'new@school.example' },
        });
        expect(reset.statusCode).toBe(429);
    });
});
