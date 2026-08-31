// `@onUpdate` on a `ClientScript`, which is the one handler no tick pass can run.
//
// Both update passes narrow to server-located handlers — a `SyncedScript`'s update belongs to the
// simulation, and firing it here as well would run it twice — so the frame loop is the only place a
// client-located update can come from.
//
// Compiled by the build (src/testkit/fixtures.ts); this file carries no decorator syntax.

import { describe, expect, it } from 'vitest';
import { displayUpdate, hud } from '@platform/core';
import { Drift, Overlay } from '../dist/testkit/fixtures.js';
import { ClientHUDSink } from '../src/hud-sink.js';
import { Mirror } from '../src/mirror.js';

/** A mirror runtime with the sink core writes widgets into, as a live session has. */
function world(): Mirror {
    const made = new Mirror({
        simRate: 60,
        bounds: { left: -1, right: 1, top: 1, bottom: -1 },
        regions: [],
    });
    made.runtime.hudSink = new ClientHUDSink();
    return made;
}

/**
 * Registers a class on a screen and leaves it open.
 *
 * `hud.screen` answers null until an open has minted the screen, so the pair below is the only way
 * to attach a class ahead of the open that runs it.
 */
function openWith(name: string, klass: never): void {
    hud.open(name);
    hud.screen(name)!.addScript(klass);
    hud.close(name);
    hud.open(name);
}

describe('displayUpdate', () => {
    it('runs a client-located @onUpdate once per call', () => {
        Overlay.frames = 0;
        const rt = world().runtime;
        openWith('overlay', Overlay as never);

        expect(Overlay.frames).toBe(0);
        displayUpdate(rt, 1 / 60);
        displayUpdate(rt, 1 / 60);
        expect(Overlay.frames).toBe(2);
    });

    it('writes through to the sink, so a redraw reaches the host', () => {
        Overlay.frames = 0;
        Overlay.label = 'first';
        const mirror = world();
        const sink = mirror.runtime.hudSink as ClientHUDSink;
        openWith('overlay', Overlay as never);

        displayUpdate(mirror.runtime, 1 / 60);
        expect(sink.widgetOf('title')?.text).toBe('first');

        Overlay.label = 'second';
        displayUpdate(mirror.runtime, 1 / 60);
        expect(sink.widgetOf('title')?.text).toBe('second');
    });

    it('leaves a synced script alone — the tick owns that one', () => {
        Drift.frames = 0;
        const mirror = world();
        const entity = mirror.runtime.entityManager.spawn('thing', 0, 0);
        entity.addScript(Drift as never);

        displayUpdate(mirror.runtime, 1 / 60);
        expect(Drift.frames).toBe(0);
    });
});

describe('ClientHUDSink deduping', () => {
    it('notifies once for a value, and not again while it is unchanged', () => {
        const sink = new ClientHUDSink();
        let notified = 0;
        sink.onChange(() => {
            notified += 1;
        });

        sink.widget('score', { visible: true, enabled: true, number: 1 });
        expect(notified).toBe(1);

        // The authored pattern writes every widget every frame. Without this, a HUD saying the same
        // thing all round would re-render its host at the frame rate.
        sink.widget('score', { visible: true, enabled: true, number: 1 });
        sink.widget('score', { visible: true, enabled: true, number: 1 });
        expect(notified).toBe(1);

        sink.widget('score', { visible: true, enabled: true, number: 2 });
        expect(notified).toBe(2);
    });

    it('sees a change in any field, including one that went absent', () => {
        const sink = new ClientHUDSink();
        let notified = 0;
        sink.onChange(() => {
            notified += 1;
        });

        sink.widget('w', { visible: true, enabled: true, text: 'x' });
        sink.widget('w', { visible: true, enabled: false, text: 'x' });
        expect(notified).toBe(2);
        sink.widget('w', { visible: true, enabled: false });
        expect(notified).toBe(3);
    });

    it('reads a rebound countdown as a change, and the same one as unchanged', () => {
        const sink = new ClientHUDSink();
        let notified = 0;
        sink.onChange(() => {
            notified += 1;
        });

        // A timer widget carries the live object rather than a sampled number, so identity is the
        // only comparison that means anything for it.
        const first = {} as never;
        const second = {} as never;
        sink.widget('clock', { visible: true, enabled: true, countdown: first });
        sink.widget('clock', { visible: true, enabled: true, countdown: first });
        expect(notified).toBe(1);
        sink.widget('clock', { visible: true, enabled: true, countdown: second });
        expect(notified).toBe(2);
    });
});
