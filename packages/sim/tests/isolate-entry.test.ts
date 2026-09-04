// The contract a host reaches a bundle through: three functions on one global, JSON either way.
//
// Driven exactly as `apps/grove/host` drives it — a string in and a string out — because a host in
// another language cannot hold anything else, and a shape that only works when both ends are
// TypeScript is not a contract at all.

import { afterEach, describe, expect, it } from 'vitest';
import { clearRuntime } from '@platform/core';
import { PROTOCOL_VERSION } from '@platform/protocol';
import { Rules } from '../dist/testkit/fixtures.js';
import { jsonCodec } from '@platform/transport';
import { idleBatch } from '../src/batch.js';
import type { InputBatch } from '../src/batch.js';
import type { EncodedBatch } from '../src/isolate-entry.js';
import { Sim } from '../src/sim.js';
import { clearIsolateEntry, installIsolateEntry, isolateEntry } from '../src/isolate-entry.js';

afterEach(() => {
    clearIsolateEntry();
    clearRuntime();
});

/** What a game bundle's own entry file does: publish the entry over the world it knows how to build. */
function install(): void {
    installIsolateEntry((config) => new Sim({ config: { ...config, gameScripts: [Rules] } }));
}

function tick(batch: InputBatch): EncodedBatch {
    return JSON.parse(isolateEntry().tick(JSON.stringify(batch))) as EncodedBatch;
}

/** The kind of an already-encoded envelope, which is all a host would ever read out of one. */
function kindOf(envelope: string): string {
    return (JSON.parse(envelope) as { kind: string }).kind;
}

describe('the isolate entry', () => {
    it('builds no world until the host says boot', () => {
        install();
        // A bundle that booted at evaluation would run every Game `@onStart` before the host had a
        // clock to advance them with.
        expect(() => isolateEntry().tick('{}')).toThrow(/not booted/);

        isolateEntry().boot(JSON.stringify({ simRate: 60, sendRate: 20 }));
        expect(tick(idleBatch(0)).tick).toBe(1);
    });

    it('carries a whole join across as nothing but two strings', () => {
        install();
        isolateEntry().boot(JSON.stringify({ simRate: 60, sendRate: 20 }));

        const opened = idleBatch(0);
        opened.opened.push({ connectionId: 'c1', identity: 'alice' });
        opened.frames.push({
            connectionId: 'c1',
            message: {
                kind: 'join-request',
                protocolVersion: PROTOCOL_VERSION,
                name: 'alice',
                clientSentMs: 1000,
                projectId: '',
                projectHash: '',
                bundleHash: '',
            },
        });
        // Identified, so the join waits on a record the host answers in a later batch — asked for on
        // the tick the request landed, since the open and the frame are both at the top of it.
        const asked = tick(opened);
        expect(asked.loads).toEqual([{ connectionId: 'c1', hostKey: 'player:alice' }]);

        const answered = idleBatch(32);
        answered.records.push({ connectionId: 'c1', fields: {} });
        tick(answered);

        let welcome: string | undefined;
        for (let i = 0; i < 16 && welcome === undefined; i++) {
            const out = tick(idleBatch(48 + i * 16, i % 3 === 2));
            welcome = out.sends.find((s) => kindOf(s.envelope) === 'welcome')?.envelope;
        }
        expect(welcome).toBeDefined();
    });

    it('hands back the CODEC’s bytes, not JSON.stringify’s', () => {
        install();
        isolateEntry().boot(JSON.stringify({ simRate: 60, sendRate: 20 }));
        const opened = idleBatch(0);
        opened.opened.push({ connectionId: 'c1', identity: null });
        opened.frames.push({
            connectionId: 'c1',
            message: {
                kind: 'join-request',
                protocolVersion: PROTOCOL_VERSION,
                name: 'anon',
                clientSentMs: 1000,
                projectId: '',
                projectHash: '',
                bundleHash: '',
            },
        });
        tick(opened);

        let welcome: string | undefined;
        for (let i = 0; i < 16 && welcome === undefined; i++) {
            const out = tick(idleBatch(16 + i * 16, i % 3 === 2));
            welcome = out.sends.find((s) => kindOf(s.envelope) === 'welcome')?.envelope;
        }
        // The codec rejects NaN, Infinity and undefined where JSON turns them into null or drops
        // them, and it is the codec the sim measured this snapshot against when it decided not to
        // chunk it. A host outside this process writes these bytes and runs no codec of its own.
        const decoded = jsonCodec.decode(welcome!);
        expect(welcome).toBe(jsonCodec.encode(decoded));
    });

    it('hands back the saves a close owes, still as one string', () => {
        install();
        isolateEntry().boot(JSON.stringify({ simRate: 60, sendRate: 20 }));
        const out = JSON.parse(isolateEntry().close()) as EncodedBatch;
        expect(out.saves).toEqual([]);
        // Inert afterwards, so a host that keeps ticking a drained world advances nothing.
        expect(tick(idleBatch(0)).sends).toEqual([]);
    });

    it('refuses a second boot rather than repointing the world under a live host', () => {
        install();
        isolateEntry().boot(JSON.stringify({ simRate: 60, sendRate: 20 }));
        expect(() => isolateEntry().boot('{}')).toThrow(/already booted/);
    });

    it('is not there until it is installed', () => {
        expect(() => isolateEntry()).toThrow(/no isolate entry/);
    });
});
