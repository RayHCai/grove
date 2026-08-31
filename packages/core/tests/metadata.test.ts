// The registry's prototype-chain metadata walk: a subclass inherits its
// parent's declarations, an override does not re-register, and a sibling's write is
// copy-on-write. Fixtures compiled by the build (src/testkit/fixtures.ts).

import { describe, it, expect, afterEach } from 'vitest';
import { DoubleJump, Movement, Sibling } from '../dist/testkit/fixtures.js';
import { getMetadata } from '../src/script/metadata.js';
import { makeInstance } from '../src/dispatch/instances.js';
import { clearRuntime, createRuntime } from '../src/runtime/runtime.js';
import { activeLocationsFor } from '../src/runtime/wiring.js';

afterEach(() => clearRuntime());

const events = (klass: abstract new () => object) =>
    (getMetadata(klass)?.handlers ?? []).map((h) => h.event).toSorted();

const jumpHandlers = (klass: abstract new () => object) =>
    (getMetadata(klass)?.handlers ?? []).filter((h) => h.event === 'jump');

describe('metadata inheritance', () => {
    it('collects the base class handlers', () => {
        const meta = getMetadata(Movement);
        expect((meta?.handlers ?? []).map((h) => `${h.kind}:${h.event}`).toSorted()).toEqual([
            'onEvent:jump',
            'onStart:@start',
        ]);
    });

    it('an override does not re-register — DoubleJump collects exactly one jump', () => {
        expect(jumpHandlers(DoubleJump)).toHaveLength(1);
        // and it inherits the parent's registration rather than owning a second
        expect(events(DoubleJump)).toEqual(['@start', 'jump']);
    });

    it('dispatch to an overridden method runs the subclass body', async () => {
        // Through the real dispatcher rather than a direct call: the claim is that the INHERITED
        // declaration still resolves the method by name on the subclass instance, and calling
        // `dj.jump()` here would assert prototype lookup instead of anything the engine does.
        const rt = createRuntime();
        const dj = new DoubleJump();
        dj.jumps = 0;
        const si = makeInstance(dj, DoubleJump, rt.scopes.createHostScope());

        await rt.dispatcher.dispatch(
            [si],
            'onEvent',
            'jump',
            'game',
            { data: {}, dt: 1 / rt.simRate, alive: true },
            { activeLocations: activeLocationsFor('server'), tick: 0 },
        );

        expect(dj.jumps).toBe(2); // subclass body (+2), not the parent's (+1)
    });

    it('a sibling adding a handler is copy-on-write — the base stays put', () => {
        expect(events(Sibling)).toEqual(['@start', 'dash', 'jump']);
        // the base Movement never gained `dash`
        expect((getMetadata(Movement)?.handlers ?? []).some((h) => h.event === 'dash')).toBe(false);
    });
});
