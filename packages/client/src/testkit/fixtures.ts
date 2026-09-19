// Compiled by the build: `tsc` lowers standard decorators and the test runner's transform does not,
// so tests import these from `../dist/testkit/`. Not public surface.

import type { Entity, HUDScreen } from '@platform/core';
import {
    ClientScript,
    ServerScript,
    SyncedScript,
    hud,
    onEventHold,
    onRequest,
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

/** A screen that redraws every frame, the authored HUD pattern; `label` is static for tests. */
export class Overlay extends ClientScript<HUDScreen> {
    static frames = 0;
    static label = 'a';

    @onUpdate
    render(): void {
        Overlay.frames += 1;
        hud.text('title', Overlay.label);
    }
}

/** The same handler on a SYNCED script; a zero counter proves the display pass never doubles it. */
export class Drift extends SyncedScript<Entity> {
    static frames = 0;

    @onUpdate
    step(): void {
        Drift.frames += 1;
    }
}

/** A server-located `@onRequest` handler; a zero counter proves `request()` left this process. */
export class LocalVault extends ServerScript {
    static asks = 0;

    @onRequest('buy')
    buy(): void {
        LocalVault.asks += 1;
    }
}
