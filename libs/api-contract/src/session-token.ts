import {
    type KeyObject,
    createPrivateKey,
    createPublicKey,
    randomBytes,
    sign as signBytes,
    verify as verifyBytes,
} from 'node:crypto';
import { z } from 'zod';
import { GameId, PlayerId, SessionId } from './ids.js';

/** A join ticket goes to `game-instance` and a store bearer to `game-manager`; both are Ed25519. */
export const TokenAudience = z.enum(['game-instance', 'game-manager']);
export type TokenAudience = z.infer<typeof TokenAudience>;

/**
 * What one service asserts about the bearer and another believes. `gameId` is carried here rather
 * than in a URL, so cross-game access is unrepresentable instead of merely checked for.
 */
export const SessionTokenClaims = z
    .object({
        gameId: GameId,
        sessionId: SessionId,
        /**
         * Who the API says the bearer is, on a `game-instance` ticket and only there. The game host
         * takes `player.id` from here, never a frame, and persisted `@serverState` is keyed by it.
         */
        playerId: PlayerId.optional(),
        aud: TokenAudience,
        /** Seconds since the epoch. Short: a session outliving its token re-asks the allocator. */
        exp: z.int().positive(),
        /** Random per ticket: two minted in one second differ, so neither is refused as reused. */
        jti: z
            .string()
            .regex(/^[A-Za-z0-9_-]{22}$/u)
            .optional(),
    })
    .refine((claims) => (claims.playerId !== undefined) === (claims.aud === 'game-instance'), {
        error: 'playerId is required on a game-instance ticket and forbidden on a store bearer',
        path: ['playerId'],
    })
    .refine((claims) => claims.jti === undefined || claims.aud === 'game-instance', {
        error: 'only a join ticket carries an id of its own',
        path: ['jti'],
    });

export type SessionTokenClaims = z.infer<typeof SessionTokenClaims>;

export type TokenFailure = 'malformed' | 'bad_signature' | 'expired' | 'wrong_audience';

export type TokenResult =
    { ok: true; claims: SessionTokenClaims } | { ok: false; reason: TokenFailure };

const b64url = (input: Buffer): string => input.toString('base64url');

/** base64url with no padding and no stray characters, which is the only spelling that verifies. */
const CANONICAL_SEGMENT = /^[A-Za-z0-9_-]+$/u;

const ED25519_SEED_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * The bytes the signature covers: the members in this order, an absent one omitted, never null.
 * Spelled out, because the Go and Rust verifiers encode the same members in the same places.
 */
function payloadOf(claims: SessionTokenClaims): string {
    const json = JSON.stringify({
        gameId: claims.gameId,
        sessionId: claims.sessionId,
        ...(claims.playerId === undefined ? {} : { playerId: claims.playerId }),
        aud: claims.aud,
        exp: claims.exp,
        ...(claims.jti === undefined ? {} : { jti: claims.jti }),
    });
    return b64url(Buffer.from(json, 'utf8'));
}

/** A fresh `jti`: 16 random bytes, which no two tickets a box remembers will share. */
export function ticketId(): string {
    return b64url(randomBytes(16));
}

function decodeKey(text: string, what: string): Buffer {
    const bytes = CANONICAL_SEGMENT.test(text) ? Buffer.from(text, 'base64url') : Buffer.alloc(0);
    if (bytes.length !== ED25519_SEED_BYTES) {
        throw new Error(`${what} must be ${ED25519_SEED_BYTES} bytes of unpadded base64url`);
    }
    return bytes;
}

/** The API's ticket-signing key, from the base64url of its 32-byte Ed25519 seed. */
export function ticketSigningKey(seed: string): KeyObject {
    return createPrivateKey({
        key: Buffer.concat([PKCS8_ED25519_PREFIX, decodeKey(seed, 'a ticket signing key')]),
        format: 'der',
        type: 'pkcs8',
    });
}

/** The verifying half, from the base64url of a raw 32-byte Ed25519 public key. */
export function ticketVerifyKey(publicKey: string): KeyObject {
    return createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: b64url(decodeKey(publicKey, 'a ticket public key')) },
        format: 'jwk',
    });
}

/** The raw public key a verifier is configured with, as base64url. */
export function ticketPublicKey(signingKey: KeyObject): string {
    const { x } = createPublicKey(signingKey).export({ format: 'jwk' });
    if (x === undefined) throw new Error('not an Ed25519 key');
    return x;
}

/** Mints a join ticket. The allocator is the only thing that should call this. */
export function signTicket(claims: SessionTokenClaims, signingKey: KeyObject): string {
    if (claims.aud !== 'game-instance') throw new Error('only a join ticket is signed here');
    const payload = payloadOf(claims);
    return `${payload}.${b64url(signBytes(null, Buffer.from(payload, 'ascii'), signingKey))}`;
}

type Segments =
    { ok: true; payload: string; signature: Buffer } | { ok: false; reason: TokenFailure };

function split(token: string): Segments {
    const dot = token.indexOf('.');
    if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'malformed' };

    const payload = token.slice(0, dot);
    const signature = token.slice(dot + 1);
    if (!CANONICAL_SEGMENT.test(payload)) return { ok: false, reason: 'malformed' };
    // A signature segment that is not canonical base64url is a bad signature rather than a bad
    // shape, which is the verdict the Go and Rust verifiers reach for the same bytes.
    if (!CANONICAL_SEGMENT.test(signature)) return { ok: false, reason: 'bad_signature' };
    return { ok: true, payload, signature: Buffer.from(signature, 'base64url') };
}

function claimsOf(payload: string, audience: TokenAudience, nowSeconds: number): TokenResult {
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

/**
 * Verifies a join ticket before it parses, so a forged payload is never handed to a schema.
 * Any one of `keys` may have signed it, so a verifier can hold the next key before the signer does.
 */
export function verifyTicket(
    token: string,
    keys: KeyObject | readonly KeyObject[],
    nowSeconds: number,
): TokenResult {
    const segments = split(token);
    if (!segments.ok) return segments;

    if (segments.signature.length !== ED25519_SIGNATURE_BYTES) {
        return { ok: false, reason: 'bad_signature' };
    }
    const payload = Buffer.from(segments.payload, 'ascii');
    const candidates = Array.isArray(keys) ? keys : [keys as KeyObject];
    if (!candidates.some((key) => verifyBytes(null, payload, key, segments.signature))) {
        return { ok: false, reason: 'bad_signature' };
    }

    return claimsOf(segments.payload, 'game-instance', nowSeconds);
}
