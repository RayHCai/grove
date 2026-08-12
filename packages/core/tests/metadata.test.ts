// The registry's prototype-chain metadata walk: a subclass inherits its
// parent's declarations, an override does not re-register, and a sibling's write is
// copy-on-write. Fixtures compiled by the build (src/testkit/fixtures.ts).

import { describe, it, expect } from 'vitest';
import { DoubleJump, Movement, Sibling } from '../dist/testkit/fixtures.js';
import { getMetadata } from '../src/script/metadata.js';

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

    it('dispatch to an overridden method runs the subclass body', () => {
        const dj = new DoubleJump();
        dj.jumps = 0;
        // simulate the dispatcher calling by declared method name
        (dj as unknown as Record<string, () => void>).jump!();
        expect(dj.jumps).toBe(2); // subclass body (+2), not the parent's (+1)
    });

    it('a sibling adding a handler is copy-on-write — the base stays put', () => {
        expect(events(Sibling)).toEqual(['@start', 'dash', 'jump']);
        // the base Movement never gained `dash`
        expect((getMetadata(Movement)?.handlers ?? []).some((h) => h.event === 'dash')).toBe(false);
    });
});
