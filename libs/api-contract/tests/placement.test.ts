// Placement: what the router hands back, and what it deliberately does not carry.

import { describe, expect, it } from 'vitest';
import { HostCapacity, HostHeartbeat, InstanceReport, Placement } from '../src/placement.js';

const HOST_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const INSTANCE_ID = '9c858901-8a57-4791-81fe-4c455b099bc9';
const SESSION_ID = '2ab5f56f-2b3a-4b1c-9c96-6a3a9ec13b8e';
const GAME_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

const placement = {
    hostId: HOST_ID,
    instanceId: INSTANCE_ID,
    sessionId: SESSION_ID,
    serverUrl: 'wss://use1-b7.grove.example/session',
};

const report = {
    instanceId: INSTANCE_ID,
    gameId: GAME_ID,
    sessionId: SESSION_ID,
    state: 'healthy',
    players: 4,
    uptimeSeconds: 91,
    port: 41337,
};

describe('a placement', () => {
    it('round-trips the wire object it was parsed from', () => {
        const parsed = Placement.parse(placement);
        expect(parsed).toEqual(placement);
        expect(Placement.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(placement);
    });

    it('drops a ticket rather than carrying one', () => {
        expect(Placement.parse({ ...placement, ticket: 'signed.elsewhere' })).not.toHaveProperty(
            'ticket',
        );
    });

    it('rejects a host that is not a uuid', () => {
        expect(Placement.safeParse({ ...placement, hostId: 'use1-b7' }).success).toBe(false);
    });
});

describe('an instance report', () => {
    it('carries the port a player dials', () => {
        expect(InstanceReport.parse(report).port).toBe(41337);
    });

    it('refuses a report with no port, and one outside the range a socket can bind', () => {
        const { port: _port, ...withoutPort } = report;
        expect(InstanceReport.safeParse(withoutPort).success).toBe(false);
        expect(InstanceReport.safeParse({ ...report, port: 0 }).success).toBe(false);
        expect(InstanceReport.safeParse({ ...report, port: 65_536 }).success).toBe(false);
    });
});

describe('a heartbeat', () => {
    const capacity = {
        runningInstances: 3,
        maxInstances: 8,
        cpuLoad: 0.42,
        memoryFreeBytes: 6_442_450_944,
    };

    it('keeps cpu load a fraction', () => {
        expect(HostCapacity.safeParse({ ...capacity, cpuLoad: 42 }).success).toBe(false);
        expect(HostCapacity.parse(capacity).cpuLoad).toBe(0.42);
    });

    it('reports an empty box as an empty list, not an absent one', () => {
        const beat = {
            hostId: HOST_ID,
            region: 'us-east-1',
            agentPort: 4004,
            capacity: { ...capacity, runningInstances: 0 },
            instances: [],
            reportedAt: '2026-09-05T12:00:00.000Z',
        };
        expect(HostHeartbeat.parse(beat).instances).toEqual([]);
        const { instances: _instances, ...withoutInstances } = beat;
        expect(HostHeartbeat.safeParse(withoutInstances).success).toBe(false);
    });

    it('names the port its own agent listens on', () => {
        const beat = {
            hostId: HOST_ID,
            region: 'us-east-1',
            agentPort: 4004,
            capacity,
            instances: [report],
            reportedAt: '2026-09-05T12:00:00.000Z',
        };
        expect(HostHeartbeat.parse(beat).agentPort).toBe(4004);
        const { agentPort: _agentPort, ...withoutAgentPort } = beat;
        expect(HostHeartbeat.safeParse(withoutAgentPort).success).toBe(false);
    });

    it('rejects an instance in a state the fleet has no handling for', () => {
        const beat = {
            hostId: HOST_ID,
            region: 'us-east-1',
            agentPort: 4004,
            capacity,
            instances: [{ ...report, state: 'paused' }],
            reportedAt: '2026-09-05T12:00:00.000Z',
        };
        expect(HostHeartbeat.safeParse(beat).success).toBe(false);
    });
});
