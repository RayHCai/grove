import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { GameId, PlayerId, SessionId } from './ids.js';

/**
 * Which service a token may be presented to.
 *
 * The two are minted with one secret and must not substitute for each other: a browser's join
 * ticket reaches a game process, and a game process's store bearer reaches the data plane, so
 * without this field the 60-second credential a player holds would also rewrite that game's rows.
 */
export const TokenAudience = z.enum(['game-instance', 'game-manager']);
export type TokenAudience = z.infer<typeof TokenAudience>;

/**
 * What one service asserts about the bearer and another believes.
 *
 * `gameId` is carried here rather than in a URL on purpose: a request cannot name a game its token
 * did not, so cross-game access is unrepresentable instead of merely checked for.
 */
export const SessionTokenClaims = z
    .object({
        gameId: GameId,
        sessionId: SessionId,
        /**
         * Who the API says the bearer is, on a `game-instance` ticket and only there.
         *
         * The game host takes `player.id` from here and never from a frame, and every other peer
         * sees it — so this is the one field that makes a ticket a claim about a PERSON rather than
         * about a session, and it is what persisted `@serverState` is keyed by across a rejoin. A
         * `game-manager` bearer belongs to the process rather than to anyone in it, and carries none.
         */
        playerId: PlayerId.optional(),
        aud: TokenAudience,
        /** Seconds since the epoch. Short — a session outliving its token re-asks the allocator. */
        exp: z.int().positive(),
    })
    .refine((claims) => (claims.playerId !== undefined) === (claims.aud === 'game-instance'), {
        error: 'playerId is required on a game-instance ticket and forbidden on a store bearer',
        path: ['playerId'],
    });

export type SessionTokenClaims = z.infer<typeof SessionTokenClaims>;

const b64url = (input: Buffer): string => input.toString('base64url');

/** base64url with no padding and no stray characters, which is the only spelling that verifies. */
const CANONICAL_SEGMENT = /^[A-Za-z0-9_-]+$/u;

function sign(payload: string, secret: string): string {
    return b64url(createHmac('sha256', secret).update(payload).digest());
}

/**
 * The bytes the signature covers: the five members, in this order, with `playerId` omitted rather
 * than written as null.
 *
 * Spelled out rather than stringified from the argument, because the Go and Rust verifiers encode
 * the same members in the same places and a caller's key order would otherwise sign a payload
 * neither of them can reproduce.
 */
function payloadOf(claims: SessionTokenClaims): string {
    return JSON.stringify({
        gameId: claims.gameId,
        sessionId: claims.sessionId,
        ...(claims.playerId === undefined ? {} : { playerId: claims.playerId }),
        aud: claims.aud,
        exp: claims.exp,
    });
}

/** Mints a token for one game session. The allocator is the only thing that should call this. */
export function signSessionToken(claims: SessionTokenClaims, secret: string): string {
    const payload = b64url(Buffer.from(payloadOf(claims), 'utf8'));
    return `${payload}.${sign(payload, secret)}`;
}

export type TokenFailure = 'malformed' | 'bad_signature' | 'expired' | 'wrong_audience';

export type TokenResult =
    { ok: true; claims: SessionTokenClaims } | { ok: false; reason: TokenFailure };

/**
 * Verifies before it parses, so a forged payload is never handed to a schema.
 *
 * `audience` is required rather than optional: every caller knows which of the two it is, and a
 * verifier that defaulted would accept the other one by omission.
 */
export function verifySessionToken(
    token: string,
    secret: string,
    nowSeconds: number,
    audience: TokenAudience,
): TokenResult {
    const dot = token.indexOf('.');
    if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'malformed' };

    const payload = token.slice(0, dot);
    const signature = token.slice(dot + 1);
    if (!CANONICAL_SEGMENT.test(payload)) return { ok: false, reason: 'malformed' };
    // A signature segment that is not canonical base64url is a bad signature rather than a bad
    // shape, which is the verdict the Go and Rust verifiers reach for the same bytes.
    if (!CANONICAL_SEGMENT.test(signature)) return { ok: false, reason: 'bad_signature' };

    const provided = Buffer.from(signature, 'base64url');
    const expected = Buffer.from(sign(payload, secret), 'base64url');

    // Length must match before `timingSafeEqual`, which throws rather than returning false on a
    // mismatch — and comparing lengths first leaks only the length, which the format already fixes.
    if (provided.length !== expected.length) return { ok: false, reason: 'bad_signature' };
    if (!timingSafeEqual(provided, expected)) return { ok: false, reason: 'bad_signature' };

    const parsed = SessionTokenClaims.safeParse(
        ((): unknown => {
            try {
                return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
            } catch {
                return undefined;
            }
        })(),
    );
    if (!parsed.success) return { ok: false, reason: 'malformed' };
    if (parsed.data.aud !== audience) return { ok: false, reason: 'wrong_audience' };
    if (parsed.data.exp <= nowSeconds) return { ok: false, reason: 'expired' };

    return { ok: true, claims: parsed.data };
}
