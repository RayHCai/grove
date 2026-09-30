// The Go suite and the Rust crates check these same fixtures, so a member renamed on any one side
// fails on all of them rather than at a join.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
    BundleSet,
    LeaderboardEntry,
    LeaderboardPage,
    LeaderboardWrite,
    StateRecord,
    StateWrite,
} from '../src/game-data.js';
import {
    Deployment,
    DeploymentRequest,
    FleetEvent,
    FleetReport,
    HostCapacity,
    HostDeployment,
    HostHeartbeat,
    HostView,
    InstanceReport,
    InstanceStart,
    Placement,
    PlacementRequest,
} from '../src/placement.js';
import {
    type HmacAudience,
    SessionTokenClaims,
    type TokenFailure,
    type TokenResult,
    signSessionToken,
    signTicket,
    ticketPublicKey,
    ticketSigningKey,
    ticketVerifyKey,
    verifySessionToken,
    verifyTicket,
} from '../src/session-token.js';
import { Task, TaskStatusUpdate } from '../src/tasks.js';
import { BuildArtifact, BuildManifest, Manifest, encodeManifest } from '../src/workspace.js';

const fixture = (name: string): unknown =>
    JSON.parse(
        readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8'),
    );

const shapes: Array<[string, z.ZodType]> = [
    ['state-record.json', StateRecord],
    ['state-write.json', StateWrite],
    ['leaderboard-entry.json', LeaderboardEntry],
    ['leaderboard-write.json', LeaderboardWrite],
    ['leaderboard-page.json', LeaderboardPage],
    ['bundle-set.json', BundleSet],
    ['placement-request.json', PlacementRequest],
    ['placement.json', Placement],
    ['host-capacity.json', HostCapacity],
    ['instance-report.json', InstanceReport],
    ['instance-start.json', InstanceStart],
    ['host-heartbeat.json', HostHeartbeat],
    ['host-view.json', HostView],
    ['fleet-event.json', FleetEvent],
    ['fleet-report.json', FleetReport],
    ['deployment-request.json', DeploymentRequest],
    ['host-deployment.json', HostDeployment],
    ['deployment.json', Deployment],
    ['task.json', Task],
    ['asset-task.json', Task],
    ['task-status-update.json', TaskStatusUpdate],
    ['asset-status-update.json', TaskStatusUpdate],
    ['manifest.json', Manifest],
    ['build-manifest.json', BuildManifest],
    ['build-artifact.json', BuildArtifact],
];

describe('every wire shape', () => {
    it.each(shapes)('parses %s without changing it', (name, schema) => {
        const document = fixture(`wire/${name}`);
        expect(schema.parse(document)).toEqual(document);
    });
});

describe('a frozen manifest', () => {
    it('is the bytes encodeManifest writes, which is what a build reads back', () => {
        const text = readFileSync(
            fileURLToPath(new URL('../fixtures/wire/manifest.json', import.meta.url)),
            'utf8',
        );
        expect(encodeManifest(Manifest.parse(JSON.parse(text)))).toBe(text);
    });
});

// game-builder sends `JSON.stringify` of the parsed update, and asset-upload-service serializes
// the same members, so the body the task route reads is these bytes from either worker.
describe('a task status update', () => {
    it.each(['task-status-update.json', 'asset-status-update.json'])(
        '%s is the body a worker sends',
        (name) => {
            const text = readFileSync(
                fileURLToPath(new URL(`../fixtures/wire/${name}`, import.meta.url)),
                'utf8',
            );
            expect(JSON.stringify(TaskStatusUpdate.parse(JSON.parse(text)))).toBe(text);
        },
    );
});

interface TokenCase {
    claims: unknown;
    payload: string;
    token: string;
}

type Verdict = 'ok' | TokenFailure;

interface TokenVector {
    secret: string;
    storeBearer: TokenCase;
    admin: TokenCase;
    hmacRefused: Array<{ name: string; audience: HmacAudience; token: string; expect: Verdict }>;
    ticket: {
        seed: string;
        publicKey: string;
        now: number;
        vectors: Array<TokenCase & { name: string; expect: Verdict }>;
    };
}

const payloadOf = (token: string): string =>
    Buffer.from(token.slice(0, token.indexOf('.')), 'base64url').toString('utf8');

const verdict = (result: TokenResult): Verdict => (result.ok ? 'ok' : result.reason);

describe('the frozen token vectors', () => {
    const vector = fixture('session-token.json') as TokenVector;
    const { ticket } = vector;

    it.each([
        ['storeBearer', 'game-manager'],
        ['admin', 'game-manager-admin'],
    ] as const)('%s is what the HMAC signer produces', (which, audience) => {
        const { claims, payload, token } = vector[which];
        const parsed = SessionTokenClaims.parse(claims);

        expect(signSessionToken(parsed, vector.secret)).toBe(token);
        expect(payloadOf(token)).toBe(payload);
        expect(verifySessionToken(token, vector.secret, 0, audience)).toEqual({
            ok: true,
            claims: parsed,
        });
    });

    it.each(vector.hmacRefused.map((c) => [c.name, c] as const))(
        'the HMAC verifier refuses %s',
        (_name, { audience, token, expect: expected }) => {
            expect(verdict(verifySessionToken(token, vector.secret, 0, audience))).toBe(expected);
        },
    );

    it('pairs the seed with the public key a verifier is configured with', () => {
        expect(ticketPublicKey(ticketSigningKey(ticket.seed))).toBe(ticket.publicKey);
    });

    it.each(ticket.vectors.map((c) => [c.name, c] as const))(
        'the ticket verifier reaches the fixture verdict on %s',
        (_name, { claims, payload, token, expect: expected }) => {
            expect(payloadOf(token)).toBe(payload);
            expect(JSON.parse(payload)).toEqual(claims);
            expect(
                verdict(verifyTicket(token, ticketVerifyKey(ticket.publicKey), ticket.now)),
            ).toBe(expected);
        },
    );

    // Ed25519 is deterministic, so each validly signed vector is exactly this signer's output.
    it.each(
        ticket.vectors
            .filter((c) => c.expect === 'ok' || c.expect === 'expired')
            .map((c) => [c.name, c] as const),
    )('%s is what the ticket signer produces', (_name, { claims, token }) => {
        expect(signTicket(SessionTokenClaims.parse(claims), ticketSigningKey(ticket.seed))).toBe(
            token,
        );
    });
});
