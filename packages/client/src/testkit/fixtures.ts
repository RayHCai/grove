// Decorator-bearing fixtures compiled by the build: `tsc` lowers standard decorators and the test
// runner's transform does not, so the tests import the compiled classes from `../dist/testkit/` and
// carry no decorator syntax themselves.
//
// Not public surface — exported only so the test suite can reach it, and the one place in this package
// that declares a script at all: `src/` proper drives core as values and attaches nothing.

import type { Entity, HUDScreen } from '@platform/core';
import {
    ClientScript,
    SyncedScript,
    hud,
    onEventHold,
    onUpdate,
    serverState,
} from '@platform/core';

/** Moves its host once per tick while `right` is held — one tick of replay, made visible. */
export class Slider extends SyncedScript<Entity> {
    /** Replicated, so a rewind that fails to take it back is a value a test can read. */
    @serverState steps = 0;

    static readonly speed = 10;

    @onEventHold('right')
    slide(): void {
        this.host.moveBy(Slider.speed, 0);
        this.steps += 1;
    }
}

/**
 * A screen that redraws every frame — the authored HUD pattern, and the one handler no tick runs.
 *
 * `label` is static so a test can change what it writes without reaching into an instance the
 * runtime owns.
 */
export class Overlay extends ClientScript<HUDScreen> {
    static frames = 0;
    static label = 'a';

    @onUpdate
    render(): void {
        Overlay.frames += 1;
        hud.text('title', Overlay.label);
    }
}

/**
 * The same handler on a SYNCED script, which the simulation already runs.
 *
 * Its counter staying at zero across a frame is what proves the display pass does not double it.
 */
export class Drift extends SyncedScript<Entity> {
    static frames = 0;

    @onUpdate
    step(): void {
        Drift.frames += 1;
    }
}
