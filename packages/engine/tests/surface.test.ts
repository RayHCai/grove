// Compile-time: the `satisfies` clauses below ARE the assertions, and this file failing to
// typecheck is the failure. The runtime block keeps vitest honest and the import a value import.

import { describe, expect, it } from 'vitest';
import { onEvent, onStart, serverState } from '../src/index.js';
import type { HUDAnchor, HandlerDecorator, StateDecorator } from '../src/index.js';
import type { UiAnchor } from '@platform/renderer';

// Mutual assignability, so a dropped member and an added one both fail.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const ANCHORS = [
    'top-left',
    'top-center',
    'top-right',
    'middle-left',
    'center',
    'middle-right',
    'bottom-left',
    'bottom-center',
    'bottom-right',
] as const satisfies readonly HUDAnchor[];

const probes = {
    anchors: true satisfies Same<HUDAnchor, (typeof ANCHORS)[number]>,
    // The renderer declares its own union rather than reach core, so nothing else holds the two equal.
    mirror: true satisfies Same<HUDAnchor, UiAnchor>,
    handlerConst: true satisfies Same<typeof onStart, HandlerDecorator>,
    handlerFactory: true satisfies Same<ReturnType<typeof onEvent>, HandlerDecorator>,
    state: true satisfies Same<typeof serverState, StateDecorator>,
};

describe('the creator surface', () => {
    it('exports HUDAnchor, HandlerDecorator and StateDecorator as the spec declares them', () => {
        expect(Object.values(probes).every(Boolean)).toBe(true);
        expect(new Set(ANCHORS).size).toBe(9);
        expect([onStart, onEvent('probe'), serverState].every((d) => typeof d === 'function')).toBe(
            true,
        );
    });
});
