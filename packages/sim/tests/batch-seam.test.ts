// The seam `apps/grove/game-instance/src/protocol.rs` mirrors, held to the same two files its suite
// round-trips, so a member renamed on either side fails on both.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { clearRuntime } from '@platform/core';
import { PROTOCOL_VERSION } from '@platform/protocol';
import { jsonCodec } from '@platform/transport';
import { Rules } from '../src/testkit/fixtures.js';
import { idleBatch } from '../src/batch.js';
import type { InputBatch } from '../src/batch.js';
import type { EncodedBatch } from '../src/isolate-entry.js';
import { Sim } from '../src/sim.js';
import { clearIsolateEntry, installIsolateEntry, isolateEntry } from '../src/isolate-entry.js';

afterEach(() => {
    clearIsolateEntry();
    clearRuntime();
});

const wire = (name: string): string =>
    readFileSync(
        fileURLToPath(new URL(`../../../libs/api-contract/fixtures/wire/${name}`, import.meta.url)),
        'utf8',
    );

const PLAYER = '33333333-3333-4333-8333-333333333333';
const LEFT = '44444444-4444-4444-8444-444444444444';

/** Every member the host writes, a nullable one both ways; the compiler holds it to the type. */
const inputBatch: InputBatch = {
    nowMs: 1767225600016.5,
    drain: true,
    opened: [
        { connectionId: 'c1', identity: PLAYER },
        { connectionId: 'c2', identity: null },
    ],
    frames: [
        {
            connectionId: 'c1',
            message: {
                kind: 'join-request',
                protocolVersion: 3,
                name: 'Wren',
                clientSentMs: 1000,
                projectId: '',
                projectHash: '',
                bundleHash: '',
            },
        },
        { connectionId: 'c2', message: { kind: 'time-sync', clientSentMs: 1000.25 } },
    ],
    closed: ['c3'],
    records: [
        { connectionId: 'c4', fields: { coins: 3, name: 'Wren' } },
        { connectionId: 'c5', fields: null },
    ],
    saved: [`player:${LEFT}`],
};

/** Every member the host reads, each send class and log level among them. */
const encodedBatch: EncodedBatch = {
    tick: 42,
    rates: { simRate: 62.5, sendRate: 12.5 },
    sends: [
        {
            to: ['c1', 'c2'],
            envelope: jsonCodec.encode({
                kind: 'time-sync-reply',
                clientSentMs: 1000.25,
                serverSentMs: 1767225600016.5,
            }) as string,
            class: 'droppable',
        },
        {
            to: ['c3'],
            envelope: jsonCodec.encode({
                kind: 'reject',
                reason: 'version',
                serverProtocolVersion: 3,
            }) as string,
            class: 'reliable',
        },
    ],
    closes: [{ connectionId: 'c3', reason: 'version' }],
    loads: [{ connectionId: 'c1', hostKey: `player:${PLAYER}` }],
    saves: [{ hostKey: `player:${LEFT}`, fields: { coins: 4, name: 'Wren' } }],
    log: [
        { level: 'debug', line: 'accept conn=c1' },
        { level: 'info', line: 'join conn=c1' },
        { level: 'warn', line: 'reject conn=c3 reason=version' },
        { level: 'error', line: 'send-dropped kind=state reason=NaN' },
    ],
    diagnostics: { dropped: 1, stale: 2 },
};

function install(): void {
    installIsolateEntry((config) => new Sim({ config: { ...config, gameScripts: [Rules] } }));
    isolateEntry().boot(JSON.stringify({ simRate: 60, sendRate: 20 }));
}

function tick(batch: string): EncodedBatch {
    return JSON.parse(isolateEntry().tick(batch)) as EncodedBatch;
}

/** A join request at `protocolVersion`, which is what decides between a load and a reject. */
function join(protocolVersion: number): Record<string, unknown> {
    return {
        kind: 'join-request',
        protocolVersion,
        name: 'Wren',
        clientSentMs: 1000,
        projectId: '',
        projectHash: '',
        bundleHash: '',
    };
}

const keysOf = (value: object): string[] => Object.keys(value).sort();

describe('the input batch', () => {
    it('is the bytes the typed batch encodes to, member for member and in order', () => {
        expect(JSON.stringify(inputBatch)).toBe(wire('input-batch.json'));
    });

    it('is a batch the isolate entry takes as the host sends it', () => {
        install();
        const out = tick(wire('input-batch.json'));
        // The identified open and its join frame were read: the sim asks for that player's record.
        expect(out.loads).toEqual([{ connectionId: 'c1', hostKey: `player:${PLAYER}` }]);
    });
});

describe('the encoded batch', () => {
    it('is the bytes the typed batch encodes to, member for member and in order', () => {
        expect(JSON.stringify(encodedBatch)).toBe(wire('encoded-batch.json'));
    });

    it('carries envelopes that are already the codec’s bytes', () => {
        for (const send of encodedBatch.sends) {
            expect(jsonCodec.encode(jsonCodec.decode(send.envelope))).toBe(send.envelope);
        }
    });

    it('names every member the isolate entry actually answers with', () => {
        install();
        const opened = idleBatch(0);
        opened.opened.push({ connectionId: 'c1', identity: PLAYER });
        opened.opened.push({ connectionId: 'c3', identity: null });
        opened.frames.push({ connectionId: 'c1', message: join(PROTOCOL_VERSION) });
        opened.frames.push({ connectionId: 'c3', message: join(PROTOCOL_VERSION + 1) });
        const out = tick(JSON.stringify(opened));
        const fixture = JSON.parse(wire('encoded-batch.json')) as EncodedBatch;

        expect(keysOf(out)).toEqual(keysOf(fixture));
        expect(keysOf(out.rates)).toEqual(keysOf(fixture.rates));
        expect(keysOf(out.diagnostics)).toEqual(keysOf(fixture.diagnostics));
        expect(keysOf(out.sends[0]!)).toEqual(keysOf(fixture.sends[0]!));
        expect(keysOf(out.closes[0]!)).toEqual(keysOf(fixture.closes[0]!));
        expect(keysOf(out.loads[0]!)).toEqual(keysOf(fixture.loads[0]!));
        expect(keysOf(out.log[0]!)).toEqual(keysOf(fixture.log[0]!));
    });
});
