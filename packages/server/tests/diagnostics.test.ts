// What an operator has after a session dies: one greppable line per denial, through core's LogSink
// seam, plus the counter that says the sim is falling behind.

import { afterEach, describe, expect, it } from 'vitest';
import type { LogSink } from '@platform/core';
import { clearRuntime } from '@platform/core';
import { PROTOCOL_VERSION } from '@platform/protocol';
import { Rules } from '../dist/testkit/fixtures.js';
import {
    INPUT_BUCKET_FRAMES,
    JOIN_DEADLINE_MS,
    MAX_UNJOINED_CONNECTIONS,
    RATE_BREACH_CLOSE,
} from '../src/constants.js';
import { harness } from './harness.js';

afterEach(() => clearRuntime());

function sink(): { lines: string[]; log: LogSink } {
    const lines: string[] = [];
    return { lines, log: { warn: (message) => lines.push(message), error: () => {} } };
}

const project = {
    projectId: 'p',
    projectHash: 'h',
    bundleHash: 'b',
    bundleUrl: '',
};

describe('every denial leaves a line', () => {
    it('names the connection and a stable reason token for each of the three rejects', () => {
        const { lines, log } = sink();
        const h = harness({ config: { gameScripts: [Rules], maxPlayers: 1, project }, log });

        const stale = h.connect();
        stale.join('stale', { protocolVersion: PROTOCOL_VERSION + 1 });
        const other = h.connect();
        other.join('other', { projectId: 'p', projectHash: 'nope', bundleHash: 'b' });
        h.pumpTicks(4);

        const identified = { projectId: 'p', projectHash: 'h', bundleHash: 'b' };
        h.connect().join('first', identified);
        h.pumpTicks(8);
        h.connect().join('second', identified);
        h.pumpTicks(8);

        expect(lines).toContain('reject conn=c1 reason=version');
        expect(lines).toContain('reject conn=c2 reason=identity');
        expect(lines).toContain('reject conn=c4 reason=full');
    });

    it('names the connection it closed for a sustained rate breach', () => {
        const { lines, log } = sink();
        const h = harness({ config: { gameScripts: [Rules] }, log });
        const noisy = h.joined('a');

        for (let i = 0; i < INPUT_BUCKET_FRAMES + RATE_BREACH_CLOSE + 8; i++) {
            noisy.input(h.tick + 1, [{ action: 'jump', on: 'press' }]);
        }
        h.pumpTicks(4);

        expect(lines).toContain('close conn=c1 reason=rate-breach');
    });

    it('names the connection the join deadline swept', () => {
        const { lines, log } = sink();
        const h = harness({ log });
        h.connect();
        h.pumpTicks(2);
        h.pump(JOIN_DEADLINE_MS / 1000);
        h.pumpTicks(2);

        expect(lines).toContain('close conn=c1 reason=join-deadline');
    });

    it('says why a socket was refused before it ever had an id', () => {
        const { lines, log } = sink();
        const h = harness({ config: { gameScripts: [Rules] }, log });
        for (let i = 0; i < MAX_UNJOINED_CONNECTIONS; i++) h.connect();
        h.pumpTicks(1);
        h.connect();

        expect(lines).toContain('accept-refused reason=unjoined-cap');
    });
});

describe('the sim falling behind is readable', () => {
    it('reports the shed count off the server, not only off the driver', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        h.pumpTicks(1);
        expect(h.server.shedCount).toBe(0);

        h.pump(5);
        expect(h.server.shedCount).toBe(1);
    });
});
