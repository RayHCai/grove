// The token both halves of a session are addressed with: what the signer produces, and what the
// verifier refuses. Pinned here because the Go and Rust verifiers are hand-written against these
// exact bytes, and agreeing about the FORMAT is not the same as agreeing about them.

import { createHmac, randomBytes, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    SessionTokenClaims,
    signSessionToken,
    signTicket,
    ticketPublicKey,
    ticketSigningKey,
    ticketVerifyKey,
    verifySessionToken,
    verifyTicket,
} from '../src/session-token.js';

const SECRET = 'a-secret-at-least-thirty-two-characters';
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

const purge = SessionTokenClaims.parse({ ...storeBearer, aud: 'game-manager-admin' });

/** The two halves, typed as the pair the format fixes rather than as an open-ended split. */
const segments = (token: string): [payload: string, signature: string] => {
    const dot = token.indexOf('.');
    return [token.slice(0, dot), token.slice(dot + 1)];
};

const b64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

/** Signs any raw segment, so a payload no signer would mint reaches the checks past the hmac. */
const mint = (payload: string): string =>
    `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`;

const mintTicket = (payload: string): string =>
    `${payload}.${sign(null, Buffer.from(payload, 'ascii'), SIGNING_KEY).toString('base64url')}`;

describe('the claim set', () => {
    it('requires a player on a join ticket and refuses one on either store audience', () => {
        const { playerId: _playerId, ...noPlayer } = ticket;
        expect(SessionTokenClaims.safeParse(noPlayer).success).toBe(false);
        for (const claims of [storeBearer, purge]) {
            expect(SessionTokenClaims.safeParse({ ...claims, playerId: PLAYER_ID }).success).toBe(
                false,
            );
        }
    });
});

describe('signing', () => {
    it('writes the members in the order the other two verifiers decode them in', () => {
        const [payload] = segments(signTicket(ticket, SIGNING_KEY));
        expect(Buffer.from(payload, 'base64url').toString('utf8')).toBe(
            `{"gameId":"${GAME_ID}","sessionId":"${SESSION_ID}","playerId":"${PLAYER_ID}","aud":"game-instance","exp":2000}`,
        );
    });

    it('omits playerId on a store bearer rather than writing it null', () => {
        const [payload] = segments(signSessionToken(storeBearer, SECRET));
        expect(Buffer.from(payload, 'base64url').toString('utf8')).toBe(
            `{"gameId":"${GAME_ID}","sessionId":"${SESSION_ID}","aud":"game-manager","exp":2000}`,
        );
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

    it('refuses signTicket for a non-game-instance audience', () => {
        // signSessionToken still mints every audience, including game-instance: see the note on
        // HmacAudience in session-token.ts. signTicket is the one exclusive to game-instance.
        expect(() => signTicket(storeBearer, SIGNING_KEY)).toThrow();
        expect(() => signTicket(purge, SIGNING_KEY)).toThrow();
    });

    it('refuses a key that is not 32 bytes of unpadded base64url', () => {
        for (const spelling of ['', 'short', `${randomBytes(32).toString('base64url')}=`]) {
            expect(() => ticketSigningKey(spelling)).toThrow();
            expect(() => ticketVerifyKey(spelling)).toThrow();
        }
    });
});

describe('verifying a store credential', () => {
    const { exp: _exp, ...noExp } = storeBearer;

    const signedButRefused: Array<[what: string, token: string]> = [
        ['a payload that is not base64url', mint('!!!!')],
        [
            'a padded payload, which the decoder would otherwise forgive',
            mint(`${b64url(JSON.stringify(storeBearer))}=`),
        ],
        ['a payload that is not JSON', mint(b64url('not json'))],
        ['a bearer with no exp', mint(b64url(JSON.stringify(noExp)))],
        [
            'a store bearer naming a player',
            mint(b64url(JSON.stringify({ ...storeBearer, playerId: PLAYER_ID }))),
        ],
    ];

    it('accepts a token it minted, for the audience it named', () => {
        const result = verifySessionToken(
            signSessionToken(storeBearer, SECRET),
            SECRET,
            1000,
            'game-manager',
        );
        expect(result).toEqual({ ok: true, claims: storeBearer });
    });

    // A claim a newer signer added must not take a verifier offline at the deploy that adds it.
    it('accepts a claim it has never heard of', () => {
        const widened = JSON.stringify({ ...storeBearer, region: 'us-east-1' });
        expect(verifySessionToken(mint(b64url(widened)), SECRET, 1000, 'game-manager')).toEqual({
            ok: true,
            claims: storeBearer,
        });
    });

    it('refuses a purge credential presented to a session route, and the reverse', () => {
        expect(
            verifySessionToken(signSessionToken(purge, SECRET), SECRET, 1000, 'game-manager'),
        ).toEqual({ ok: false, reason: 'wrong_audience' });
        expect(
            verifySessionToken(
                signSessionToken(storeBearer, SECRET),
                SECRET,
                1000,
                'game-manager-admin',
            ),
        ).toEqual({ ok: false, reason: 'wrong_audience' });
    });

    it('refuses a join ticket, whichever scheme signed it', () => {
        expect(
            verifySessionToken(signTicket(ticket, SIGNING_KEY), SECRET, 1000, 'game-manager'),
        ).toEqual({ ok: false, reason: 'bad_signature' });
        expect(
            verifySessionToken(mint(b64url(JSON.stringify(ticket))), SECRET, 1000, 'game-manager'),
        ).toEqual({ ok: false, reason: 'wrong_audience' });
    });

    it('refuses another signer, and a payload edited after signing', () => {
        expect(
            verifySessionToken(
                signSessionToken(storeBearer, 'another-secret-entirely'),
                SECRET,
                1000,
                'game-manager',
            ),
        ).toEqual({ ok: false, reason: 'bad_signature' });

        const [, signature] = segments(signSessionToken(storeBearer, SECRET));
        const forged = b64url(JSON.stringify({ ...storeBearer, gameId: PLAYER_ID }));
        expect(verifySessionToken(`${forged}.${signature}`, SECRET, 1000, 'game-manager')).toEqual({
            ok: false,
            reason: 'bad_signature',
        });
    });

    it('expires at the second the claim names, not after it', () => {
        const token = signSessionToken(storeBearer, SECRET);
        expect(verifySessionToken(token, SECRET, 1999, 'game-manager').ok).toBe(true);
        expect(verifySessionToken(token, SECRET, 2000, 'game-manager')).toEqual({
            ok: false,
            reason: 'expired',
        });
    });

    it('refuses a signature that is padded or otherwise not canonical base64url', () => {
        const [payload, signature] = segments(signSessionToken(storeBearer, SECRET));
        for (const spelling of [`${signature}=`, `${signature}==`, `${signature.slice(0, -1)}+`]) {
            expect(
                verifySessionToken(`${payload}.${spelling}`, SECRET, 1000, 'game-manager'),
            ).toEqual({ ok: false, reason: 'bad_signature' });
        }
    });

    // Reaches the length guard that keeps `timingSafeEqual` from throwing out of a verifier.
    it('refuses a canonical signature of the wrong length', () => {
        const [payload] = segments(signSessionToken(storeBearer, SECRET));
        expect(verifySessionToken(`${payload}.YWJj`, SECRET, 1000, 'game-manager')).toEqual({
            ok: false,
            reason: 'bad_signature',
        });
    });

    it('refuses a token with no signature at all', () => {
        for (const spelling of ['no-dot-here', 'payload.', '.signature']) {
            expect(verifySessionToken(spelling, SECRET, 1000, 'game-manager')).toEqual({
                ok: false,
                reason: 'malformed',
            });
        }
    });

    it.each(signedButRefused)('refuses %s, signature and all', (_what, token) => {
        expect(verifySessionToken(token, SECRET, 1000, 'game-manager')).toEqual({
            ok: false,
            reason: 'malformed',
        });
    });
});

describe('verifying a join ticket', () => {
    it('accepts a ticket the signing key minted', () => {
        expect(verifyTicket(signTicket(ticket, SIGNING_KEY), VERIFY_KEY, 1000)).toEqual({
            ok: true,
            claims: ticket,
        });
    });

    it('refuses a ticket under HMAC, even one signed with the store secret', () => {
        expect(verifyTicket(mint(b64url(JSON.stringify(ticket))), VERIFY_KEY, 1000)).toEqual({
            ok: false,
            reason: 'bad_signature',
        });
    });

    it('refuses a store audience the signing key was made to sign', () => {
        expect(
            verifyTicket(mintTicket(b64url(JSON.stringify(storeBearer))), VERIFY_KEY, 1000),
        ).toEqual({
            ok: false,
            reason: 'wrong_audience',
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

    it('refuses a signature that is not canonical base64url', () => {
        const [payload, signature] = segments(signTicket(ticket, SIGNING_KEY));
        expect(verifyTicket(`${payload}.${signature}=`, VERIFY_KEY, 1000)).toEqual({
            ok: false,
            reason: 'bad_signature',
        });
    });
});
