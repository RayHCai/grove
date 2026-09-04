import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { GameId, PlayerId, SessionId } from './ids.js';

/**
 * What a game process presents to reach its own data, and what a browser presents to reach a game
 * process — one token type, because both answer the same question about the same session.
 *
 * `gameId` is carried here rather than in a URL on purpose: a request cannot name a game its token
 * did not, so cross-game access is unrepresentable instead of merely checked for.
 */
export const SessionTokenClaims = z.object({
    gameId: GameId,
    sessionId: SessionId,
    /**
     * Who the API says the bearer is.
     *
     * The game host takes `player.id` from here and never from a frame, and every other peer sees
     * it — so this is the one field that makes a ticket a claim about a PERSON rather than about a
     * session, and it is what persisted `@serverState` is keyed by across a rejoin.
     */
    playerId: PlayerId,
    /** Seconds since the epoch. Short — a session outliving its token re-asks the allocator. */
    exp: z.int().positive(),
});

export type SessionTokenClaims = z.infer<typeof SessionTokenClaims>;

const b64url = (input: Buffer): string => input.toString('base64url');

function sign(payload: string, secret: string): string {
    return b64url(createHmac('sha256', secret).update(payload).digest());
}

/** Mints a token for one game session. The allocator is the only thing that should call this. */
export function signSessionToken(claims: SessionTokenClaims, secret: string): string {
    const payload = b64url(Buffer.from(JSON.stringify(claims), 'utf8'));
    return `${payload}.${sign(payload, secret)}`;
}

export type TokenFailure = 'malformed' | 'bad_signature' | 'expired';

export type TokenResult =
    { ok: true; claims: SessionTokenClaims } | { ok: false; reason: TokenFailure };

/** Verifies before it parses, so a forged payload is never handed to a schema. */
export function verifySessionToken(token: string, secret: string, nowSeconds: number): TokenResult {
    const dot = token.indexOf('.');
    if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'malformed' };

    const payload = token.slice(0, dot);
    const provided = Buffer.from(token.slice(dot + 1), 'base64url');
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
    if (parsed.data.exp <= nowSeconds) return { ok: false, reason: 'expired' };

    return { ok: true, claims: parsed.data };
}
