// Signing up, the four things the holder of an account may do to it, resetting a forgotten password,
// and making a game — every gate in front of each, and what each seam outcome becomes on the wire.

import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { GameId, PlayerId } from '@grove/api-contract';
import type { GameVisibility } from '@grove/api-contract';
import { buildApp } from '../src/app.js';
import type { Mailer } from '../src/mailer.js';
import { readEnv } from '../src/env.js';
import { unattachedRecords } from '../src/records.js';
import type { AccountRecord, GameRecord, Records } from '../src/records.js';

const HOLDER = PlayerId.parse('f47ac10b-58cc-4372-a567-0e02b2c3d479');
const STRANGER = PlayerId.parse('2b6d4f8a-1c3e-4d5f-9a7b-6c8d0e2f4a1b');
const GAME_ID = GameId.parse('9f1c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f');
const PASSWORD = 'a long enough password';

const env = readEnv({
    NODE_ENV: 'test',
    SESSION_SECRET: 'a'.repeat(32),
    GAME_TOKEN_SECRET: 'b'.repeat(32),
    FLEET_SECRET: 'c'.repeat(32),
    TRUSTED_PROXIES: '10.0.0.9',
    PLATFORM_ORIGIN: 'https://grove.example',
    EDITOR_ORIGIN: 'https://editor.grove.example',
    SERVER_MANAGER_URL: 'http://server-manager.grove.internal:4003',
    UPLOAD_SERVICE_URL: 'http://upload-service.grove.internal:4005',
    GAME_BUILDER_URL: 'http://game-builder.grove.internal:4002',
});

function account(over: Partial<AccountRecord> = {}): AccountRecord {
    return {
        playerId: HOLDER,
        email: 'creator@grove.example',
        displayName: 'Creator',
        createdAt: '2026-09-16T00:00:00.000Z',
        ...over,
    };
}

function game(over: Partial<GameRecord> = {}): GameRecord {
    return {
        gameId: GAME_ID,
        ownerId: HOLDER,
        title: 'My Game',
        visibility: 'private',
        createdAt: '2026-09-16T00:00:00.000Z',
        ...over,
    };
}

/**
 * A store that answers whatever a test needs, over the unattached seam.
 *
 * Spread over `unattachedRecords` so a method a test did not name answers "nothing is attached"
 * rather than throwing — and so a widened seam never silently hands this double a real answer.
 */
function store(over: Partial<Records> = {}): Records {
    return { ...unattachedRecords, ...over };
}

/** A store that holds one account with a password, which is what most of these tests need. */
function holding(over: Partial<Records> = {}): Records {
    return store({
        signIn: async (email, password) =>
            email === 'creator@grove.example' && password === PASSWORD ? HOLDER : undefined,
        accountOf: async () => account(),
        profileOf: async (player) => ({ playerId: player, displayName: 'Creator' }),
        ...over,
    });
}

/** The cookie and the token every later write has to carry. */
function credentials(response: { cookies: { name: string; value: string }[]; json: () => any }): {
    cookie: string;
    csrfToken: string;
} {
    const cookie = response.cookies.find((candidate) => candidate.name === 'sessionId');
    return { cookie: `sessionId=${cookie?.value ?? ''}`, csrfToken: response.json().csrfToken };
}

async function signUp(
    app: FastifyInstance,
    body: Record<string, unknown> = {},
): Promise<{ cookie: string; csrfToken: string; status: number; body: any }> {
    const response = await app.inject({
        method: 'POST',
        url: '/v1/players',
        payload: {
            email: 'creator@grove.example',
            password: PASSWORD,
            displayName: 'Creator',
            ...body,
        },
    });
    return { ...credentials(response), status: response.statusCode, body: response.json() };
}

async function signIn(app: FastifyInstance): Promise<{ cookie: string; csrfToken: string }> {
    const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/sessions',
        payload: { email: 'creator@grove.example', password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    return credentials(response);
}

describe('signing up', () => {
    it('mints a session, and a token the next write is let through with', async () => {
        const app = await buildApp(
            env,
            store({
                createAccount: async () => ({ outcome: 'created', account: account() }),
                createGame: async () => ({ outcome: 'created', game: game() }),
            }),
        );
        const { status, body, cookie, csrfToken } = await signUp(app);
        expect(status).toBe(201);
        expect(body.playerId).toBe(HOLDER);

        const write = await app.inject({
            method: 'POST',
            url: '/v1/games',
            headers: { cookie, 'x-csrf-token': csrfToken },
            payload: { title: 'My Game' },
        });
        expect(write.statusCode).toBe(201);
    });

    it('hands the store the address folded, so one mailbox cannot become two accounts', async () => {
        let seen: string | undefined;
        const app = await buildApp(
            env,
            store({
                createAccount: async (email) => {
                    seen = email;
                    return { outcome: 'created', account: account() };
                },
            }),
        );
        await signUp(app, { email: 'Creator@Grove.Example' });
        expect(seen).toBe('creator@grove.example');
    });

    it('refuses an address that already answers to somebody', async () => {
        const app = await buildApp(
            env,
            store({ createAccount: async () => ({ outcome: 'taken' }) }),
        );
        const { status, body } = await signUp(app);
        expect(status).toBe(409);
        expect(body.code).toBe('conflict');
    });

    it('refuses a password shorter than the policy', async () => {
        const app = await buildApp(env, store());
        const { status, body } = await signUp(app, { password: 'short' });
        expect(status).toBe(400);
        expect(body.code).toBe('invalid_request');
    });

    it('refuses a display name that would render as something else', async () => {
        const app = await buildApp(env, store());
        // A right-to-left override, which makes a name read backwards wherever it is shown.
        const { status } = await signUp(app, { displayName: `Creator‮` });
        expect(status).toBe(400);
    });

    it('refuses a display name that is only whitespace', async () => {
        const app = await buildApp(env, store());
        expect((await signUp(app, { displayName: '   ' })).status).toBe(400);
    });

    it('trims the display name before the store ever sees it', async () => {
        let seen: string | undefined;
        const app = await buildApp(
            env,
            store({
                createAccount: async (_email, _password, displayName) => {
                    seen = displayName;
                    return { outcome: 'created', account: account() };
                },
            }),
        );
        await signUp(app, { displayName: '  Creator  ' });
        expect(seen).toBe('Creator');
    });

    it('says so rather than pretending, while no store is attached', async () => {
        const app = await buildApp(env, unattachedRecords);
        const { status, body } = await signUp(app);
        expect(status).toBe(501);
        expect(body.code).toBe('internal');
    });

    it('is rationed far tighter than the app, because it is a credential path', async () => {
        const app = await buildApp(
            env,
            store({ createAccount: async () => ({ outcome: 'taken' }) }),
        );
        const response = await app.inject({
            method: 'POST',
            url: '/v1/players',
            payload: { email: 'creator@grove.example', password: PASSWORD, displayName: 'Creator' },
        });
        expect(Number(response.headers['x-ratelimit-limit'])).toBe(10);
    });

    it('leaves reading a profile on the app budget rather than the credential one', async () => {
        const app = await buildApp(env, holding());
        const { cookie } = await signIn(app);
        const response = await app.inject({
            method: 'GET',
            url: '/v1/players/me',
            headers: { cookie },
        });
        expect(response.statusCode).toBe(200);
        expect(Number(response.headers['x-ratelimit-limit'])).toBe(300);
    });
});

describe('an account its holder is reading', () => {
    it('comes back without any column a password lives in', async () => {
        const app = await buildApp(env, holding());
        const { cookie } = await signIn(app);
        const response = await app.inject({
            method: 'GET',
            url: '/v1/players/me',
            headers: { cookie },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(account());
        expect(JSON.stringify(response.json())).not.toMatch(/argon2|hash/iu);
    });

    it('is refused to a caller holding no session', async () => {
        const app = await buildApp(env, holding());
        expect((await app.inject({ method: 'GET', url: '/v1/players/me' })).statusCode).toBe(401);
    });

    it('renames, once the token rides along', async () => {
        const app = await buildApp(
            env,
            holding({
                renameAccount: async (_p, displayName) => ({
                    outcome: 'renamed',
                    account: account({ displayName }),
                }),
            }),
        );
        const { cookie, csrfToken } = await signIn(app);
        const response = await app.inject({
            method: 'PATCH',
            url: '/v1/players/me',
            headers: { cookie, 'x-csrf-token': csrfToken },
            payload: { displayName: 'Renamed' },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().displayName).toBe('Renamed');
    });

    it('says the seam is empty rather than that the account is gone', async () => {
        const app = await buildApp(env, holding());
        const { cookie, csrfToken } = await signIn(app);
        const response = await app.inject({
            method: 'PATCH',
            url: '/v1/players/me',
            headers: { cookie, 'x-csrf-token': csrfToken },
            payload: { displayName: 'Renamed' },
        });
        expect(response.statusCode).toBe(501);
    });

    it('does not rename for a caller who brought the cookie and nothing else', async () => {
        const app = await buildApp(env, holding());
        const { cookie } = await signIn(app);
        const response = await app.inject({
            method: 'PATCH',
            url: '/v1/players/me',
            headers: { cookie },
            payload: { displayName: 'Renamed' },
        });
        expect(response.statusCode).toBe(403);
    });
});

describe('an account somebody else is reading', () => {
    it('is a name and an id, and never the address', async () => {
        const app = await buildApp(env, holding());
        const { cookie } = await signIn(app);
        const response = await app.inject({
            method: 'GET',
            url: `/v1/players/${STRANGER}`,
            headers: { cookie },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ playerId: STRANGER, displayName: 'Creator' });
        expect(response.json().email).toBeUndefined();
    });

    it('is refused to a caller holding no session', async () => {
        const app = await buildApp(env, holding());
        const response = await app.inject({ method: 'GET', url: `/v1/players/${STRANGER}` });
        expect(response.statusCode).toBe(401);
    });
});

describe('changing a password', () => {
    it('is refused to a caller who cannot produce the current one', async () => {
        const app = await buildApp(
            env,
            holding({ changePassword: async () => ({ outcome: 'wrong_password' }) }),
        );
        const { cookie, csrfToken } = await signIn(app);
        const response = await app.inject({
            method: 'PUT',
            url: '/v1/players/me/password',
            headers: { cookie, 'x-csrf-token': csrfToken },
            payload: { currentPassword: 'not it', newPassword: 'another long password' },
        });
        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe('forbidden');
    });

    it('ends every other session the account was holding', async () => {
        const app = await buildApp(
            env,
            holding({ changePassword: async () => ({ outcome: 'ok' }) }),
        );
        const elsewhere = await signIn(app);
        const here = await signIn(app);

        const changed = await app.inject({
            method: 'PUT',
            url: '/v1/players/me/password',
            headers: { cookie: here.cookie, 'x-csrf-token': here.csrfToken },
            payload: { currentPassword: PASSWORD, newPassword: 'another long password' },
        });
        expect(changed.statusCode).toBe(200);

        const stale = await app.inject({
            method: 'GET',
            url: '/v1/players/me',
            headers: { cookie: elsewhere.cookie },
        });
        expect(stale.statusCode).toBe(401);
    });

    it('leaves the caller able to write, which rotating the session alone would not', async () => {
        const app = await buildApp(
            env,
            holding({
                changePassword: async () => ({ outcome: 'ok' }),
                createGame: async () => ({ outcome: 'created', game: game() }),
            }),
        );
        const before = await signIn(app);
        const changed = await app.inject({
            method: 'PUT',
            url: '/v1/players/me/password',
            headers: { cookie: before.cookie, 'x-csrf-token': before.csrfToken },
            payload: { currentPassword: PASSWORD, newPassword: 'another long password' },
        });
        expect(changed.statusCode).toBe(200);

        // The rotation drops the CSRF secret along with the old session, so the token handed back
        // with it is the only one the next write can carry.
        const after = credentials(changed);
        const write = await app.inject({
            method: 'POST',
            url: '/v1/games',
            headers: { cookie: after.cookie, 'x-csrf-token': after.csrfToken },
            payload: { title: 'My Game' },
        });
        expect(write.statusCode).toBe(201);
    });

    it('does not let a session survive on a request that was already in flight', async () => {
        const app = await buildApp(
            env,
            holding({ changePassword: async () => ({ outcome: 'ok' }) }),
        );
        const thief = await signIn(app);
        const holder = await signIn(app);

        // The plugin saves a live session on every request while `rolling` is on, so a revoked id
        // comes straight back unless the store refuses to take it again.
        const [, changed] = await Promise.all([
            app.inject({ method: 'GET', url: '/v1/players/me', headers: { cookie: thief.cookie } }),
            app.inject({
                method: 'PUT',
                url: '/v1/players/me/password',
                headers: { cookie: holder.cookie, 'x-csrf-token': holder.csrfToken },
                payload: { currentPassword: PASSWORD, newPassword: 'another long password' },
            }),
        ]);
        expect(changed.statusCode).toBe(200);

        const after = await app.inject({
            method: 'GET',
            url: '/v1/players/me',
            headers: { cookie: thief.cookie },
        });
        expect(after.statusCode).toBe(401);
    });

    it('holds the new password to the same policy as the first one', async () => {
        const app = await buildApp(
            env,
            holding({ changePassword: async () => ({ outcome: 'ok' }) }),
        );
        const { cookie, csrfToken } = await signIn(app);
        const response = await app.inject({
            method: 'PUT',
            url: '/v1/players/me/password',
            headers: { cookie, 'x-csrf-token': csrfToken },
            payload: { currentPassword: PASSWORD, newPassword: 'short' },
        });
        expect(response.statusCode).toBe(400);
    });
});

describe('making a game', () => {
    it('creates one for the player the cookie names', async () => {
        let owner: string | undefined;
        const app = await buildApp(
            env,
            holding({
                createGame: async (asked, title) => {
                    owner = asked;
                    return { outcome: 'created', game: game({ title }) };
                },
            }),
        );
        const { cookie, csrfToken } = await signIn(app);
        const response = await app.inject({
            method: 'POST',
            url: '/v1/games',
            headers: { cookie, 'x-csrf-token': csrfToken },
            payload: { title: 'My Game' },
        });
        expect(response.statusCode).toBe(201);
        expect(response.json()).toEqual(game());
        // From the cookie, never from the body: whoever asks owns what they made.
        expect(owner).toBe(HOLDER);
    });

    it('is refused to a caller holding no session', async () => {
        const app = await buildApp(env, holding());
        const response = await app.inject({
            method: 'POST',
            url: '/v1/games',
            payload: { title: 'My Game' },
        });
        expect(response.statusCode).toBe(401);
    });

    it('is refused to a write carrying the cookie and no token', async () => {
        const app = await buildApp(env, holding());
        const { cookie } = await signIn(app);
        const response = await app.inject({
            method: 'POST',
            url: '/v1/games',
            headers: { cookie },
            payload: { title: 'My Game' },
        });
        expect(response.statusCode).toBe(403);
    });

    it('refuses a title that is only whitespace', async () => {
        const app = await buildApp(env, holding());
        const { cookie, csrfToken } = await signIn(app);
        const response = await app.inject({
            method: 'POST',
            url: '/v1/games',
            headers: { cookie, 'x-csrf-token': csrfToken },
            payload: { title: '  ' },
        });
        expect(response.statusCode).toBe(400);
    });

    it('says so rather than pretending, while no store is attached', async () => {
        const app = await buildApp(env, holding());
        const { cookie, csrfToken } = await signIn(app);
        const response = await app.inject({
            method: 'POST',
            url: '/v1/games',
            headers: { cookie, 'x-csrf-token': csrfToken },
            payload: { title: 'My Game' },
        });
        expect(response.statusCode).toBe(501);
    });

    it('lists what the caller owns, and asks the store for nobody else', async () => {
        let asked: string | undefined;
        const app = await buildApp(
            env,
            holding({
                gamesOf: async (owner) => {
                    asked = owner;
                    return [game()];
                },
            }),
        );
        const { cookie } = await signIn(app);
        const response = await app.inject({
            method: 'GET',
            url: '/v1/games',
            headers: { cookie },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual([game()]);
        expect(asked).toBe(HOLDER);
    });

    it('does not collide with the publish routes that take an id', async () => {
        const app = await buildApp(env, holding({ ownerOf: async () => HOLDER }));
        const { cookie } = await signIn(app);
        // The create scope carries no `requireGameOwner`, and the publish scope still does.
        const mine = await app.inject({
            method: 'GET',
            url: `/v1/games/${GAME_ID}/versions/latest`,
            headers: { cookie },
        });
        expect(mine.statusCode).toBe(404);
    });
});

describe('who may play a game', () => {
    /** The store behind the settings route: one game, owned by whoever `owner` names. */
    function owning(owner = HOLDER, over: Partial<Records> = {}): Records {
        let visibility: GameVisibility = 'private';
        return holding({
            ownerOf: async (asked) => (asked === GAME_ID ? owner : undefined),
            gameOf: async (asked) => (asked === GAME_ID ? game({ visibility }) : undefined),
            setVisibility: async (asked, next) => {
                if (asked !== GAME_ID) return { outcome: 'missing' };
                visibility = next;
                return { outcome: 'updated', game: game({ visibility }) };
            },
            ...over,
        });
    }

    it('is the owner to set, and is what a later read answers', async () => {
        const app = await buildApp(env, owning());
        const { cookie, csrfToken } = await signIn(app);
        const response = await app.inject({
            method: 'PATCH',
            url: `/v1/games/${GAME_ID}`,
            headers: { cookie, 'x-csrf-token': csrfToken },
            payload: { visibility: 'public' },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(game({ visibility: 'public' }));
    });

    it('is not somebody else to set, whatever they own', async () => {
        const app = await buildApp(env, owning(STRANGER));
        const { cookie, csrfToken } = await signIn(app);
        const response = await app.inject({
            method: 'PATCH',
            url: `/v1/games/${GAME_ID}`,
            headers: { cookie, 'x-csrf-token': csrfToken },
            payload: { visibility: 'public' },
        });

        expect(response.statusCode).toBe(403);
    });

    it('refuses a value that is not one of the three', async () => {
        const app = await buildApp(env, owning());
        const { cookie, csrfToken } = await signIn(app);
        const response = await app.inject({
            method: 'PATCH',
            url: `/v1/games/${GAME_ID}`,
            headers: { cookie, 'x-csrf-token': csrfToken },
            payload: { visibility: 'everyone' },
        });

        expect(response.statusCode).toBe(400);
    });

    it('needs the token every other write needs', async () => {
        const app = await buildApp(env, owning());
        const { cookie } = await signIn(app);
        const response = await app.inject({
            method: 'PATCH',
            url: `/v1/games/${GAME_ID}`,
            headers: { cookie },
            payload: { visibility: 'public' },
        });

        expect(response.statusCode).toBe(403);
    });
});

/** A mailer that remembers what it was asked to send, which is what the route hands the store. */
function outbox(): Mailer & { sent: { to: string; link: string }[] } {
    const sent: { to: string; link: string }[] = [];
    return {
        sent,
        sendPasswordReset: async (to, link) => {
            sent.push({ to, link });
            return { outcome: 'sent' };
        },
    };
}

async function askForReset(app: FastifyInstance, email = 'creator@grove.example') {
    return app.inject({ method: 'POST', url: '/v1/auth/password-resets', payload: { email } });
}

describe('resetting a forgotten password', () => {
    const TOKEN = 'a-reset-key';

    it('mails a link to the address the store named', async () => {
        const mail = outbox();
        const app = await buildApp(
            env,
            holding({
                beginPasswordReset: async () => ({
                    outcome: 'begun',
                    email: 'creator@grove.example',
                    token: TOKEN,
                }),
            }),
            undefined,
            undefined,
            undefined,
            mail,
        );
        expect((await askForReset(app)).statusCode).toBe(202);
        expect(mail.sent).toHaveLength(1);
        expect(mail.sent[0]?.to).toBe('creator@grove.example');
        // The link points at the platform, not at this service: the page that collects the new
        // password is not a route here.
        expect(mail.sent[0]?.link).toBe(`https://grove.example/reset-password?token=${TOKEN}`);
    });

    // The one property this route exists to have: an unauthenticated caller cannot use it to learn
    // which addresses have accounts.
    it('answers the same, and as fast, for an address nobody holds', async () => {
        const mail = outbox();
        const app = await buildApp(
            env,
            holding({
                beginPasswordReset: async (email) =>
                    email === 'creator@grove.example'
                        ? { outcome: 'begun', email, token: TOKEN }
                        : { outcome: 'no_account' },
            }),
            undefined,
            undefined,
            undefined,
            mail,
        );
        const held = await askForReset(app);
        const unheld = await askForReset(app, 'nobody@grove.example');

        expect(held.statusCode).toBe(202);
        expect(unheld.statusCode).toBe(202);
        expect(held.body).toBe(unheld.body);
        // And nothing was mailed for the address nobody holds.
        expect(mail.sent).toHaveLength(1);
    });

    it('folds the address before the store is asked', async () => {
        let seen: string | undefined;
        const app = await buildApp(
            env,
            holding({
                beginPasswordReset: async (email) => {
                    seen = email;
                    return { outcome: 'no_account' };
                },
            }),
            undefined,
            undefined,
            undefined,
            outbox(),
        );
        await askForReset(app, 'Creator@Grove.Example');
        expect(seen).toBe('creator@grove.example');
    });

    it('says so rather than swallowing the request, while no mailer is attached', async () => {
        const app = await buildApp(
            env,
            holding({
                beginPasswordReset: async () => ({
                    outcome: 'begun',
                    email: 'creator@grove.example',
                    token: TOKEN,
                }),
            }),
        );
        expect((await askForReset(app)).statusCode).toBe(501);
    });

    it('is rationed on the same budget as signing in', async () => {
        const app = await buildApp(env, holding(), undefined, undefined, undefined, outbox());
        expect(Number((await askForReset(app)).headers['x-ratelimit-limit'])).toBe(10);
    });

    it('sets the new password and ends every session the account was holding', async () => {
        const app = await buildApp(
            env,
            holding({ finishPasswordReset: async () => ({ outcome: 'reset', player: HOLDER }) }),
            undefined,
            undefined,
            undefined,
            outbox(),
        );
        const open = await signIn(app);

        const reset = await app.inject({
            method: 'PUT',
            url: '/v1/auth/password',
            payload: { token: TOKEN, newPassword: 'a brand new long password' },
        });
        expect(reset.statusCode).toBe(204);
        // Not signed in by the reset: whoever used the link proved the address, not the session.
        expect(reset.headers['set-cookie']).toBeUndefined();

        const stale = await app.inject({
            method: 'GET',
            url: '/v1/players/me',
            headers: { cookie: open.cookie },
        });
        expect(stale.statusCode).toBe(401);
    });

    it('refuses a key the store would not take, without saying which kind of bad it was', async () => {
        const app = await buildApp(
            env,
            holding({ finishPasswordReset: async () => ({ outcome: 'refused' }) }),
            undefined,
            undefined,
            undefined,
            outbox(),
        );
        const response = await app.inject({
            method: 'PUT',
            url: '/v1/auth/password',
            payload: { token: 'stale', newPassword: 'a brand new long password' },
        });
        expect(response.statusCode).toBe(401);
        expect(response.json().message).toBe('that link is no longer good');
    });

    it('holds the new password to the same policy as the first one', async () => {
        const app = await buildApp(env, holding(), undefined, undefined, undefined, outbox());
        const response = await app.inject({
            method: 'PUT',
            url: '/v1/auth/password',
            payload: { token: TOKEN, newPassword: 'short' },
        });
        expect(response.statusCode).toBe(400);
    });
});
