// The token both halves of a session are addressed with: what the signer produces, and what the
// verifier refuses. Pinned here because the Go and Rust verifiers are hand-written against these
// exact bytes, and agreeing about the FORMAT is not the same as agreeing about them.

import { createHmac, randomBytes, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    SessionTokenClaims,
    TokenAudience,
    signTicket,
    ticketId,
    ticketPublicKey,
    ticketSigningKey,
    ticketVerifyKey,
    verifyTicket,
} from '../src/session-token.js';

const GAME_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const PLAYER_ID = '33333333-3333-4333-8333-333333333333';

const SIGNING_KEY = ticketSigningKey(randomBytes(32).toString('base64url'));
const VERIFY_KEY = ticketVerifyKey(ticketPublicKey(SIGNING_KEY));

const ticket = SessionTokenClaims.parse({
    gameId: GAME_ID,
    sessionId: SESSION_ID,
    playerId: PLAYER_ID,
    aud: 'game-instance',
    exp: 2000,
});

const storeBearer = SessionTokenClaims.parse({
    gameId: GAME_ID,
    sessionId: SESSION_ID,
    aud: 'game-manager',
    exp: 2000,
});

/** The two halves, typed as the pair the format fixes rather than as an open-ended split. */
const segments = (token: string): [payload: string, signature: string] => {
    const dot = token.indexOf('.');
    return [token.slice(0, dot), token.slice(dot + 1)];
};

const b64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

/** Signs any raw segment, so a payload no signer would mint reaches the checks after it. */
const mintTicket = (payload: string): string =>
    `${payload}.${sign(null, Buffer.from(payload, 'ascii'), SIGNING_KEY).toString('base64url')}`;

describe('the claim set', () => {
    it('requires a player on a join ticket and refuses one on a store bearer', () => {
        const { playerId: _playerId, ...noPlayer } = ticket;
        expect(SessionTokenClaims.safeParse(noPlayer).success).toBe(false);
        expect(SessionTokenClaims.safeParse({ ...storeBearer, playerId: PLAYER_ID }).success).toBe(
            false,
        );
    });

    it('names the two services a token is presented to, and nothing a verifier refuses', () => {
        expect(TokenAudience.options).toEqual(['game-instance', 'game-manager']);
    });
});

describe('signing', () => {
    it('writes the members in the order the other two verifiers decode them in', () => {
        const [payload] = segments(signTicket(ticket, SIGNING_KEY));
        expect(Buffer.from(payload, 'base64url').toString('utf8')).toBe(
            `{"gameId":"${GAME_ID}","sessionId":"${SESSION_ID}","playerId":"${PLAYER_ID}","aud":"game-instance","exp":2000}`,
        );
    });

    it('writes a ticket id last, after every member a verifier already decoded', () => {
        const jti = ticketId();
        const [payload] = segments(signTicket({ ...ticket, jti }, SIGNING_KEY));
        expect(Buffer.from(payload, 'base64url').toString('utf8')).toBe(
            `{"gameId":"${GAME_ID}","sessionId":"${SESSION_ID}","playerId":"${PLAYER_ID}","aud":"game-instance","exp":2000,"jti":"${jti}"}`,
        );
        expect(verifyTicket(signTicket({ ...ticket, jti }, SIGNING_KEY), VERIFY_KEY, 1000)).toEqual(
            {
                ok: true,
                claims: { ...ticket, jti },
            },
        );
    });

    // Ed25519 is deterministic, so without an id of their own two tickets for one join are one.
    it('mints two tickets for one join in one second that differ, which a box refusing reuse needs', () => {
        const first = signTicket({ ...ticket, jti: ticketId() }, SIGNING_KEY);
        const second = signTicket({ ...ticket, jti: ticketId() }, SIGNING_KEY);
        expect(first).not.toBe(second);
        expect(ticketId()).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    });

    it('puts an id on a join ticket alone', () => {
        expect(SessionTokenClaims.safeParse({ ...storeBearer, jti: ticketId() }).success).toBe(
            false,
        );
        expect(SessionTokenClaims.safeParse({ ...ticket, jti: 'short' }).success).toBe(false);
    });

    it('signs the same bytes whatever order the caller built its claims in', () => {
        const shuffled = SessionTokenClaims.parse({
            exp: 2000,
            aud: 'game-instance',
            playerId: PLAYER_ID,
            sessionId: SESSION_ID,
            gameId: GAME_ID,
        });
        expect(signTicket(shuffled, SIGNING_KEY)).toBe(signTicket(ticket, SIGNING_KEY));
    });

    it('refuses to sign a store bearer, which server-manager mints under its own key', () => {
        expect(() => signTicket(storeBearer, SIGNING_KEY)).toThrow();
    });

    it('refuses a key that is not 32 bytes of unpadded base64url', () => {
        for (const spelling of ['', 'short', `${randomBytes(32).toString('base64url')}=`]) {
            expect(() => ticketSigningKey(spelling)).toThrow();
            expect(() => ticketVerifyKey(spelling)).toThrow();
        }
    });
});

describe('verifying a join ticket', () => {
    it('accepts a ticket the signing key minted', () => {
        expect(verifyTicket(signTicket(ticket, SIGNING_KEY), VERIFY_KEY, 1000)).toEqual({
            ok: true,
            claims: ticket,
        });
    });

    // A verifier holds the next key before the signer switches to it, so both verify at once.
    it('accepts a ticket any one of its keys signed, in whichever order they are held', () => {
        const next = ticketSigningKey(randomBytes(32).toString('base64url'));
        const keys = [VERIFY_KEY, ticketVerifyKey(ticketPublicKey(next))];
        expect(verifyTicket(signTicket(ticket, SIGNING_KEY), keys, 1000).ok).toBe(true);
        expect(verifyTicket(signTicket(ticket, next), keys, 1000).ok).toBe(true);
        expect(verifyTicket(signTicket(ticket, next), keys.toReversed(), 1000).ok).toBe(true);
    });

    it('refuses a ticket none of its keys signed, and an empty key list outright', () => {
        const stranger = ticketSigningKey(randomBytes(32).toString('base64url'));
        expect(verifyTicket(signTicket(ticket, stranger), [VERIFY_KEY], 1000)).toEqual({
            ok: false,
            reason: 'bad_signature',
        });
        expect(verifyTicket(signTicket(ticket, SIGNING_KEY), [], 1000)).toEqual({
            ok: false,
            reason: 'bad_signature',
        });
    });

    it('refuses a ticket under HMAC, whatever secret signed it', () => {
        const payload = b64url(JSON.stringify(ticket));
        const hmac = createHmac('sha256', 'a-secret-at-least-thirty-two-characters')
            .update(payload)
            .digest('base64url');
        expect(verifyTicket(`${payload}.${hmac}`, VERIFY_KEY, 1000)).toEqual({
            ok: false,
            reason: 'bad_signature',
        });
    });

    it('refuses a store audience the signing key was made to sign', () => {
        expect(
            verifyTicket(mintTicket(b64url(JSON.stringify(storeBearer))), VERIFY_KEY, 1000),
        ).toEqual({ ok: false, reason: 'wrong_audience' });
    });

    // A claim a newer signer added must not take a verifier offline at the deploy that adds it.
    it('accepts a claim it has never heard of', () => {
        const widened = b64url(JSON.stringify({ ...ticket, region: 'us-east-1' }));
        expect(verifyTicket(mintTicket(widened), VERIFY_KEY, 1000)).toEqual({
            ok: true,
            claims: ticket,
        });
    });

    it('refuses another key, and a payload edited after signing', () => {
        const stranger = ticketSigningKey(randomBytes(32).toString('base64url'));
        expect(verifyTicket(signTicket(ticket, stranger), VERIFY_KEY, 1000)).toEqual({
            ok: false,
            reason: 'bad_signature',
        });

        const [, signature] = segments(signTicket(ticket, SIGNING_KEY));
        const forged = b64url(JSON.stringify({ ...ticket, playerId: PLAYER_ID.replace('3', '4') }));
        expect(verifyTicket(`${forged}.${signature}`, VERIFY_KEY, 1000)).toEqual({
            ok: false,
            reason: 'bad_signature',
        });
    });

    it('expires at the second the claim names, not after it', () => {
        const token = signTicket(ticket, SIGNING_KEY);
        expect(verifyTicket(token, VERIFY_KEY, 1999).ok).toBe(true);
        expect(verifyTicket(token, VERIFY_KEY, 2000)).toEqual({ ok: false, reason: 'expired' });
    });

    it('refuses a ticket with no player, signature and all', () => {
        const { playerId: _playerId, ...noPlayer } = ticket;
        expect(
            verifyTicket(mintTicket(b64url(JSON.stringify(noPlayer))), VERIFY_KEY, 1000),
        ).toEqual({ ok: false, reason: 'malformed' });
    });

    it('refuses a payload that is not base64url, or not JSON, signature and all', () => {
        for (const payload of ['!!!!', `${b64url(JSON.stringify(ticket))}=`, b64url('not json')]) {
            expect(verifyTicket(mintTicket(payload), VERIFY_KEY, 1000)).toEqual({
                ok: false,
                reason: 'malformed',
            });
        }
    });

    it('refuses a signature that is not canonical base64url, or not 64 bytes', () => {
        const [payload, signature] = segments(signTicket(ticket, SIGNING_KEY));
        for (const spelling of [`${signature}=`, `${signature.slice(0, -1)}+`, 'YWJj']) {
            expect(verifyTicket(`${payload}.${spelling}`, VERIFY_KEY, 1000)).toEqual({
                ok: false,
                reason: 'bad_signature',
            });
        }
    });

    it('refuses a token with no signature at all', () => {
        for (const spelling of ['no-dot-here', 'payload.', '.signature']) {
            expect(verifyTicket(spelling, VERIFY_KEY, 1000)).toEqual({
                ok: false,
                reason: 'malformed',
            });
        }
    });
});
