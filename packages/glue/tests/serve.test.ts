// Over a real socket, because both bounds are `ws`'s and the listener's: a loopback pair has no
// payload limit and no raw bytes to count.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { PROJECT_FORMAT_VERSION } from '@platform/project';
import type { ProjectManifest } from '@platform/project';
import { MAX_CLIENT_FRAME_BYTES } from '@platform/protocol';
import { GameInstance, listenOn } from '../src/server/index.js';
import type { ServedGame } from '../src/server/index.js';

function project(): ProjectManifest {
    return {
        formatVersion: PROJECT_FORMAT_VERSION,
        projectId: 'serve-test',
        contentHash: '1',
        settings: {
            simRate: 60,
            sendRate: 20,
            maxPlayers: 4,
            bounds: { left: -100, right: 100, top: 100, bottom: -100 },
            regions: [],
        },
        assets: [],
        scriptModules: [],
        templates: [],
        entities: [],
        gameScripts: [],
    };
}

/** Teardown for whatever `connect` opened, run newest first. */
const opened: Array<() => Promise<void>> = [];

afterEach(async () => {
    for (const close of opened.splice(0).toReversed()) await close();
});

/** A listener on an ephemeral port, and a client socket connected to it. */
async function connect(lines: string[]): Promise<WebSocket> {
    const http = createServer();
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const served: ServedGame = listenOn(new GameInstance({ project: project() }), {
        server: http,
        onLog: (line) => lines.push(line),
    });
    opened.push(async () => {
        await served.close();
        await new Promise<void>((resolve) => http.close(() => resolve()));
    });
    const { port } = http.address() as AddressInfo;
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    opened.push(() => {
        socket.terminate();
        return Promise.resolve();
    });
    await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
    });
    return socket;
}

function closeCode(socket: WebSocket): Promise<number> {
    return new Promise((resolve) => socket.once('close', (code: number) => resolve(code)));
}

/** A frame the codec decodes whole, padded to `bytes`. */
function padded(bytes: number): string {
    const head = '{"kind":"time-sync","clientSentMs":1,"pad":"';
    return `${head}${'x'.repeat(bytes - head.length - 2)}"}`;
}

describe('a served game', () => {
    it('refuses a frame past the client frame cap before buffering it, rather than at 100 MiB', async () => {
        const socket = await connect([]);
        const closed = closeCode(socket);
        socket.send('x'.repeat(MAX_CLIENT_FRAME_BYTES + 1));
        // 1009 is `ws` enforcing `maxPayload`; a transport refusal after a full read closes otherwise.
        expect(await closed).toBe(1009);
    });

    it('closes a socket sending more than its byte budget inside a second', async () => {
        const lines: string[] = [];
        const socket = await connect(lines);
        const closed = closeCode(socket);
        // Each under the frame cap, five together over the four-frame budget.
        const frame = padded(MAX_CLIENT_FRAME_BYTES - 64);
        for (let i = 0; i < 5; i++) socket.send(frame);
        expect(await closed).toBe(1008);
        expect(lines.some((line) => line.includes('bytes in a second'))).toBe(true);
    });
});
