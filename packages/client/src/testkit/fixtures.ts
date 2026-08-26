// Decorator-bearing fixtures compiled by the build: `tsc` lowers standard decorators and the test
// runner's transform does not, so the tests import the compiled classes from `../dist/testkit/` and
// carry no decorator syntax themselves.
//
// Not public surface — exported only so the test suite can reach it, and the one place in this package
// that declares a script at all: `src/` proper drives core as values and attaches nothing.

import type { Entity } from '@platform/core';
import { SyncedScript, onEventHold, serverState } from '@platform/core';

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
