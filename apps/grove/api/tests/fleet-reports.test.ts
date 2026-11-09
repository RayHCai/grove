// Where @grove/server-manager leaves the fleet's history, and what this service refuses to take.

import { describe, expect, it, vi } from 'vitest';
import { HostId, type FleetReport } from '@grove/api-contract';
import { buildApp } from '../src/app.js';
import { BUILDER_SECRET, SERVER_MANAGER_SECRET, testEnv } from './fixtures.js';
import type { Stores } from '../src/records.js';
import { stores } from './doubles.js';

const BEARER = SERVER_MANAGER_SECRET;
const HOST_ID = HostId.parse('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
const INCARNATION = '2b1c6f70-9d3a-4a21-8f55-0c9f7a1d4e88';
const EVENT_ID = 'c5a1f0e2-7b34-4d89-9a6c-1e2f3a4b5c6d';

const env = testEnv();

const report: FleetReport = {
    hosts: [
        {
            hostId: HOST_ID,
            region: 'us-east-1',
            capacity: {
                runningInstances: 3,
                maxInstances: 8,
                cpuLoad: 0.42,
                memoryFreeBytes: 6_442_450_944,
            },
            lastSeenAt: '2026-09-05T12:00:03.250Z',
            liveness: 'healthy',
            incarnation: INCARNATION,
        },
    ],
    events: [
        {
            eventId: EVENT_ID,
            hostId: HOST_ID,
            region: 'us-east-1',
            kind: 'registered',
            incarnation: INCARNATION,
            at: '2026-09-05T12:00:00.000Z',
        },
    ],
    reportedAt: '2026-09-05T12:00:30.000Z',
};

function recording(): { records: Stores; recordFleet: ReturnType<typeof vi.fn> } {
    const recordFleet = vi.fn(async () => {});
    return { records: stores({ fleetHistory: { recordFleet } }), recordFleet };
}

describe('POST /v1/fleet/reports', () => {
    it('hands the whole report to the store', async () => {
        const { records, recordFleet } = recording();
        const app = await buildApp(env, records);

        const response = await app.inject({
            method: 'POST',
            url: '/v1/fleet/reports',
            headers: { authorization: `Bearer ${BEARER}` },
            payload: report,
        });

        expect(response.statusCode).toBe(204);
        expect(recordFleet).toHaveBeenCalledOnce();
        expect(recordFleet.mock.calls[0]?.[0]).toMatchObject({
            hosts: [{ hostId: HOST_ID, liveness: 'healthy' }],
            events: [{ eventId: EVENT_ID, kind: 'registered' }],
        });
    });

    // The router is the only caller, by the secret it alone shares with this service.
    it("refuses a caller without the router's secret, a builder's included", async () => {
        const { records, recordFleet } = recording();
        const app = await buildApp(env, records);

        for (const headers of [{}, { authorization: `Bearer ${BUILDER_SECRET}` }]) {
            const response = await app.inject({
                method: 'POST',
                url: '/v1/fleet/reports',
                headers,
                payload: report,
            });
            expect(response.statusCode).toBe(401);
        }
        expect(recordFleet).not.toHaveBeenCalled();
    });

    // A liveness this service has no handling for is a router it does not share a vocabulary with,
    // which is a deploy half-done rather than a row to write and puzzle over later.
    it('refuses a liveness that is not one of the four', async () => {
        const { records, recordFleet } = recording();
        const app = await buildApp(env, records);

        const response = await app.inject({
            method: 'POST',
            url: '/v1/fleet/reports',
            headers: { authorization: `Bearer ${BEARER}` },
            payload: {
                ...report,
                hosts: [{ ...report.hosts[0], liveness: 'probably-fine' }],
            },
        });

        expect(response.statusCode).toBe(400);
        expect(recordFleet).not.toHaveBeenCalled();
    });

    // An empty report is the ordinary case: the fleet is quiet and nothing has transitioned, and
    // the snapshot still has to land so the rows do not age.
    it('takes a report with no events', async () => {
        const { records, recordFleet } = recording();
        const app = await buildApp(env, records);

        const response = await app.inject({
            method: 'POST',
            url: '/v1/fleet/reports',
            headers: { authorization: `Bearer ${BEARER}` },
            payload: { ...report, events: [] },
        });

        expect(response.statusCode).toBe(204);
        expect(recordFleet).toHaveBeenCalledOnce();
    });
});
