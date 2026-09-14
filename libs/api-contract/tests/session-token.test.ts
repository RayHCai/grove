// The token both halves of a session are addressed with: what the signer produces, and what the
// verifier refuses. Pinned here because the Go and Rust verifiers are hand-written against these
// exact bytes, and agreeing about the FORMAT is not the same as agreeing about them.

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SessionTokenClaims, signSessionToken, verifySessionToken } from '../src/session-token.js';

const SECRET = 'a-secret-at-least-thirty-two-characters';
const GAME_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const PLAYER_ID = '33333333-3333-4333-8333-333333333333';

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

/** Signs any raw segment, so a payload no signer would mint reaches the checks past the hmac. */
const mint = (payload: string): string =>
    `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`;

describe('the claim set', () => {
    it('requires a player on a join ticket and refuses one on a store bearer', () => {
        const { playerId: _playerId, ...noPlayer } = ticket;
        expect(SessionTokenClaims.safeParse(noPlayer).success).toBe(false);
        expect(SessionTokenClaims.safeParse({ ...storeBearer, playerId: PLAYER_ID }).success).toBe(
            false,
        );
    });
});

describe('signing', () => {
    it('writes the members in the order the other two verifiers decode them in', () => {
        const [payload] = segments(signSessionToken(ticket, SECRET));
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
        expect(signSessionToken(shuffled, SECRET)).toBe(signSessionToken(ticket, SECRET));
    });
});

describe('verifying', () => {
    const { exp: _exp, ...noExp } = ticket;
    const { playerId: _playerId, ...noPlayer } = ticket;

    const signedButRefused: Array<[what: string, token: string]> = [
        ['a payload that is not base64url', mint('!!!!')],
        [
            'a padded payload, which the decoder would otherwise forgive',
            mint(`${b64url(JSON.stringify(ticket))}=`),
        ],
        ['a payload that is not JSON', mint(b64url('not json'))],
        ['a ticket with no exp', mint(b64url(JSON.stringify(noExp)))],
        ['a ticket with no player', mint(b64url(JSON.stringify(noPlayer)))],
        [
            'a store bearer naming a player',
            mint(b64url(JSON.stringify({ ...storeBearer, playerId: PLAYER_ID }))),
        ],
    ];

    it('accepts a token it minted, for the audience it named', () => {
        const result = verifySessionToken(
            signSessionToken(ticket, SECRET),
            SECRET,
            1000,
            'game-instance',
        );
        expect(result).toEqual({ ok: true, claims: ticket });
    });

    // A claim a newer allocator added must not take a verifier offline at the deploy that adds it.
    it('accepts a claim it has never heard of', () => {
        const widened = JSON.stringify({ ...ticket, region: 'us-east-1' });
        expect(verifySessionToken(mint(b64url(widened)), SECRET, 1000, 'game-instance')).toEqual({
            ok: true,
            claims: ticket,
        });
    });

    it('refuses a join ticket presented to the store, and the reverse', () => {
        expect(
            verifySessionToken(signSessionToken(ticket, SECRET), SECRET, 1000, 'game-manager'),
        ).toEqual({ ok: false, reason: 'wrong_audience' });
        expect(
            verifySessionToken(
                signSessionToken(storeBearer, SECRET),
                SECRET,
                1000,
                'game-instance',
            ),
        ).toEqual({ ok: false, reason: 'wrong_audience' });
    });

    it('refuses another signer, and a payload edited after signing', () => {
        expect(
            verifySessionToken(
                signSessionToken(ticket, 'another-secret-entirely'),
                SECRET,
                1000,
                'game-instance',
            ),
        ).toEqual({ ok: false, reason: 'bad_signature' });

        const [, signature] = segments(signSessionToken(ticket, SECRET));
        const forged = Buffer.from(
            JSON.stringify({ ...ticket, playerId: PLAYER_ID.replace('3', '4') }),
            'utf8',
        ).toString('base64url');
        expect(verifySessionToken(`${forged}.${signature}`, SECRET, 1000, 'game-instance')).toEqual(
            { ok: false, reason: 'bad_signature' },
        );
    });

    it('expires at the second the claim names, not after it', () => {
        const token = signSessionToken(ticket, SECRET);
        expect(verifySessionToken(token, SECRET, 1999, 'game-instance').ok).toBe(true);
        expect(verifySessionToken(token, SECRET, 2000, 'game-instance')).toEqual({
            ok: false,
            reason: 'expired',
        });
    });

    it('refuses a signature that is padded or otherwise not canonical base64url', () => {
        const [payload, signature] = segments(signSessionToken(ticket, SECRET));
        for (const spelling of [`${signature}=`, `${signature}==`, `${signature.slice(0, -1)}+`]) {
            expect(
                verifySessionToken(`${payload}.${spelling}`, SECRET, 1000, 'game-instance'),
            ).toEqual({ ok: false, reason: 'bad_signature' });
        }
    });

    // Reaches the length guard that keeps `timingSafeEqual` from throwing out of a verifier.
    it('refuses a canonical signature of the wrong length', () => {
        const [payload] = segments(signSessionToken(ticket, SECRET));
        expect(verifySessionToken(`${payload}.YWJj`, SECRET, 1000, 'game-instance')).toEqual({
            ok: false,
            reason: 'bad_signature',
        });
    });

    it('refuses a token with no signature at all', () => {
        for (const spelling of ['no-dot-here', 'payload.', '.signature']) {
            expect(verifySessionToken(spelling, SECRET, 1000, 'game-instance')).toEqual({
                ok: false,
                reason: 'malformed',
            });
        }
    });

    it.each(signedButRefused)('refuses %s, signature and all', (_what, token) => {
        expect(verifySessionToken(token, SECRET, 1000, 'game-instance')).toEqual({
            ok: false,
            reason: 'malformed',
        });
    });
});
