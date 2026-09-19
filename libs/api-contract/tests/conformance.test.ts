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
import { SessionTokenClaims, signSessionToken, verifySessionToken } from '../src/session-token.js';

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
];

describe('every wire shape', () => {
    it.each(shapes)('parses %s without changing it', (name, schema) => {
        const document = fixture(`wire/${name}`);
        expect(schema.parse(document)).toEqual(document);
    });
});

interface TokenCase {
    claims: unknown;
    payload: string;
    token: string;
}

interface TokenVector {
    secret: string;
    ticket: TokenCase;
    storeBearer: TokenCase;
    anotherTicketByTheSameSigner: TokenCase;
}

describe('the frozen token vector', () => {
    const vector = fixture('session-token.json') as TokenVector;

    // The third is pinned too because the Go suite forges with its payload, and a literal nothing
    // re-derives stops being this signer's output with nobody noticing.
    it.each([
        ['ticket', 'game-instance'],
        ['storeBearer', 'game-manager'],
        ['anotherTicketByTheSameSigner', 'game-instance'],
    ] as const)('%s is what this signer produces', (which, audience) => {
        const { claims, payload, token } = vector[which];
        const parsed = SessionTokenClaims.parse(claims);

        expect(signSessionToken(parsed, vector.secret)).toBe(token);
        expect(Buffer.from(token.slice(0, token.indexOf('.')), 'base64url').toString('utf8')).toBe(
            payload,
        );
        expect(verifySessionToken(token, vector.secret, 0, audience)).toEqual({
            ok: true,
            claims: parsed,
        });
    });
});
