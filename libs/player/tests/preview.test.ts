// A world running in this page, which is what an editor's preview mounts a session against.
//
// The classes below carry no decorators: vitest's transform does not lower TC39 decorators, and
// what this file is about is the wiring — that a real `Sim` boots, that a pair reaches it, and that
// the session is handed the classes its own half needs.

import { describe, expect, it, vi } from 'vitest';
import { ManualFrameSource, ScriptedInputDevice } from '@platform/client';
import { ClientScript, ServerScript, clearRuntime } from '@platform/core';
import { PROJECT_FORMAT_VERSION, assetId, scriptId, templateId } from '@platform/project';
import type { ProjectManifest } from '@platform/project';
import { createReadyNullRenderer } from '@platform/renderer/null';
import type { ScriptEntry } from '@platform/scripting';
import type { ScriptId } from '@platform/project';
import { ClientInstance } from '@platform/glue/client';
import { bootPreview } from '../src/preview.js';

const RULES = scriptId('rules');
const HUD = scriptId('hud');
const PIP = templateId('pip');
const DOT = assetId('dot');

class Rules extends ServerScript {
    readonly side = 'server';
}
class Hud extends ClientScript {
    readonly side = 'client';
}

function scripts(): ScriptEntry<ScriptId>[] {
    return [
        { id: RULES, location: 'server', ctor: Rules },
        { id: HUD, location: 'client', ctor: Hud },
    ];
}

function project(): ProjectManifest {
    return {
        formatVersion: PROJECT_FORMAT_VERSION,
        projectId: 'preview-test',
        contentHash: 'abc123',
        settings: {
            simRate: 60,
            sendRate: 20,
            maxPlayers: 4,
            bounds: { left: -100, right: 100, top: 100, bottom: -100 },
            regions: [],
        },
        assets: [{ id: DOT, kind: 'texture', url: '/dot.png' }],
        scriptModules: [
            {
                path: 'rules.ts',
                scripts: [{ id: RULES, export: 'Rules', location: 'server', host: 'game' }],
            },
            {
                path: 'hud.ts',
                scripts: [{ id: HUD, export: 'Hud', location: 'client', host: 'game' }],
            },
        ],
        templates: [{ id: PIP, visual: { kind: 'sprite', texture: DOT }, scripts: [] }],
        entities: [
            {
                id: 'a-pip',
                template: PIP,
                parent: null,
                transform: { x: 5 },
                tags: [],
                scripts: [],
            },
        ],
        gameScripts: [{ script: RULES }],
    };
}

describe('booting a world in this page', () => {
    it('claims the identity the world it booted declares', () => {
        const preview = bootPreview({ project: project(), scripts: scripts() });
        try {
            // `contentHash` IS `projectHash` on the wire, so a session claiming what this answers
            // is claiming exactly what the authority beside it will compare against.
            expect(preview.project).toEqual({
                projectId: 'preview-test',
                projectHash: 'abc123',
            });
        } finally {
            preview.dispose();
            clearRuntime();
        }
    });

    it('is a local authority, never a url to dial', () => {
        const preview = bootPreview({ project: project(), scripts: scripts() });
        try {
            expect(preview.authority.kind).toBe('local');
        } finally {
            preview.dispose();
            clearRuntime();
        }
    });

    it('hands the session the client half, and keeps the server half from it', () => {
        const preview = bootPreview({ project: project(), scripts: scripts() });
        try {
            if (preview.authority.kind !== 'local') throw new Error('expected a local authority');
            const registry = preview.authority.scripts;

            // A `ServerScript` reaching a client tick is the seam leaking one class at a time, so
            // the session's registry holds the client half and nothing else.
            expect(registry.resolve(HUD)).toBe(Hud);
            expect(registry.resolve(RULES)).toBeUndefined();
        } finally {
            preview.dispose();
            clearRuntime();
        }
    });

    it('admits a session over the pair it opens, and takes it live', async () => {
        const preview = bootPreview({ project: project(), scripts: scripts() });
        if (preview.authority.kind !== 'local') throw new Error('expected a local authority');

        // This test owns the clock, so the world's own must be off: a driver pumped against both
        // the wall clock and a counter starting at zero is told time ran backwards, and stops.
        preview.pause();
        const link = preview.authority.open();
        const frames = new ManualFrameSource();
        const renderer = await createReadyNullRenderer({ design: { width: 800, height: 600 } });
        let now = 0;

        const session = new ClientInstance({
            transport: link.transport,
            pump: link.pump,
            renderer,
            frames,
            device: new ScriptedInputDevice(),
            clock: { nowSeconds: () => now },
            name: 'Creator',
            project: preview.project,
            scripts: preview.authority.scripts,
        }).start();

        try {
            // The whole point of the preview: a real handshake against a real `Sim`, with nothing
            // between the two ends but a pair somebody has to turn.
            for (let i = 0; i < 20 && session.state !== 'live'; i += 1) {
                now += 1 / 60;
                // Both ends, by hand, against one clock: in a browser the world's own interval
                // turns it, and here there is no real time passing for that interval to fire in.
                preview.pump(now);
                frames.frame(now);
                // An identified join awaits a store read before a Player is allocated, so the
                // admission finishes on the microtask queue rather than inside the pump.
                // oxlint-disable-next-line no-await-in-loop
                await new Promise((resolve) => setTimeout(resolve, 0));
            }

            expect(session.state).toBe('live');
        } finally {
            session.close();
            link.close?.();
            preview.dispose();
            clearRuntime();
        }
    });

    it('ends the world when the preview is disposed, not when one session leaves', () => {
        const preview = bootPreview({ project: project(), scripts: scripts() });
        if (preview.authority.kind !== 'local') throw new Error('expected a local authority');

        const first = preview.authority.open();
        first.close?.();

        // A creator who reloads the stage is one session leaving, not the world ending: the next
        // open has to reach the same authority.
        expect(() => preview.authority.kind === 'local' && preview.authority.open()).not.toThrow();

        preview.dispose();
        clearRuntime();
    });

    it('stops the clock on a pause and starts it again on a resume', () => {
        // A pause holds the world still, so what is asserted is the clock turning it: an interval
        // that survived a pause is a stage saying "paused" over a world that kept ticking.
        vi.useFakeTimers();
        try {
            const idle = vi.getTimerCount();
            const preview = bootPreview({ project: project(), scripts: scripts() });
            expect(vi.getTimerCount()).toBe(idle + 1);

            preview.pause();
            expect(vi.getTimerCount()).toBe(idle);

            preview.resume();
            expect(vi.getTimerCount()).toBe(idle + 1);

            // A second resume is the same world, not a second clock over it.
            preview.resume();
            expect(vi.getTimerCount()).toBe(idle + 1);

            preview.dispose();
            expect(vi.getTimerCount()).toBe(idle);
        } finally {
            vi.useRealTimers();
            clearRuntime();
        }
    });

    it('forwards what the world logs to whoever booted it', async () => {
        const lines: string[] = [];
        const preview = bootPreview({
            project: project(),
            scripts: scripts(),
            onLog: (line) => lines.push(line),
        });
        if (preview.authority.kind !== 'local') throw new Error('expected a local authority');

        try {
            // The world's own clock off, this test's on — see the note in the admission case.
            preview.pause();
            // One preview is one player, so a second stage opened before the first has joined is
            // refused — and the only place that refusal is ever stated is this channel.
            preview.authority.open();
            preview.authority.open();
            let now = 0;
            for (let i = 0; i < 5 && lines.length === 0; i += 1) {
                now += 1 / 60;
                preview.pump(now);
                // oxlint-disable-next-line no-await-in-loop
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
            expect(lines.join(' ')).toContain('accept-refused');
        } finally {
            preview.dispose();
            clearRuntime();
        }
    });
});
