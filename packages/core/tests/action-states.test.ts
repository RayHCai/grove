// The input fold both endpoints run.
//
// It is pure on purpose: the server folds a connection's edges and the client folds its own, and a
// second implementation of the one-tick-wide rule would read as a prediction mismatch rather than
// as the bug it is. Every rule below is one the two ends have to agree on edge for edge.

import { describe, it, expect } from 'vitest';
import { createActionStates } from '../src/runtime/action-states.js';

describe('a press', () => {
    it('sets held and pressed together, and drives the axis to one', () => {
        const s = createActionStates();
        s.applyEdge({ action: 'jump', on: 'press' });
        expect(s.held('jump')).toBe(true);
        expect(s.pressed('jump')).toBe(true);
        expect(s.released('jump')).toBe(false);
        // A bound button reads as a full axis, so a movement type filling intent from one works
        // whether the binding was a key or a stick.
        expect(s.axis('jump')).toBe(1);
    });

    it('leaves every other action neutral', () => {
        const s = createActionStates();
        s.applyEdge({ action: 'jump', on: 'press' });
        expect(s.held('fire')).toBe(false);
        expect(s.axis('fire')).toBe(0);
    });
});

describe('a release', () => {
    it('clears held, raises released, and returns the axis to neutral', () => {
        const s = createActionStates();
        s.applyEdge({ action: 'jump', on: 'press' });
        s.advanceTick();
        s.applyEdge({ action: 'jump', on: 'release' });
        expect(s.held('jump')).toBe(false);
        expect(s.released('jump')).toBe(true);
        expect(s.axis('jump')).toBe(0);
    });

    it('carries both edges when a tap opens and closes inside one tick', () => {
        const s = createActionStates();
        s.applyEdge({ action: 'jump', on: 'press' });
        s.applyEdge({ action: 'jump', on: 'release' });
        // Both are true on this one tick, and the release is what won for `held`.
        expect(s.pressed('jump')).toBe(true);
        expect(s.released('jump')).toBe(true);
        expect(s.held('jump')).toBe(false);
    });
});

describe('the one-tick-wide rule', () => {
    it('drops pressed and released on the next tick and keeps held', () => {
        const s = createActionStates();
        s.applyEdge({ action: 'jump', on: 'press' });
        s.advanceTick();
        expect(s.pressed('jump')).toBe(false);
        expect(s.held('jump')).toBe(true);

        s.applyEdge({ action: 'jump', on: 'release' });
        s.advanceTick();
        expect(s.released('jump')).toBe(false);
        expect(s.held('jump')).toBe(false);
    });

    it('keeps an axis across ticks, because a stick is a level and not an edge', () => {
        const s = createActionStates();
        s.applyEdge({ action: 'move', on: 'press', value: 0.4 });
        s.advanceTick();
        s.advanceTick();
        expect(s.axis('move')).toBe(0.4);
    });
});

describe('a hold sample', () => {
    it('updates the axis without claiming an edge', () => {
        const s = createActionStates();
        s.applyEdge({ action: 'move', on: 'press' });
        s.advanceTick();
        s.applyEdge({ action: 'move', on: 'hold', value: 0.25 });
        expect(s.axis('move')).toBe(0.25);
        // `pressed` is one tick wide by definition, and a hold is not that tick.
        expect(s.pressed('move')).toBe(false);
        expect(s.held('move')).toBe(true);
    });

    it('does not make an unheld action held, so a neutral stick is not a press', () => {
        const s = createActionStates();
        s.applyEdge({ action: 'move', on: 'hold', value: 0.9 });
        expect(s.held('move')).toBe(false);
        expect(s.pressed('move')).toBe(false);
        expect(s.axis('move')).toBe(0.9);
    });

    it('carrying no value leaves the axis where it was', () => {
        const s = createActionStates();
        s.applyEdge({ action: 'move', on: 'press', value: 0.6 });
        s.applyEdge({ action: 'move', on: 'hold' });
        expect(s.axis('move')).toBe(0.6);
    });
});

describe('an explicit value on the edge', () => {
    it('wins over the button default, which is what carries a stick’s magnitude', () => {
        const s = createActionStates();
        s.applyEdge({ action: 'move', on: 'press', value: 0.3 });
        expect(s.axis('move')).toBe(0.3);
        s.applyEdge({ action: 'move', on: 'release', value: -1 });
        expect(s.axis('move')).toBe(-1);
    });
});

describe('what the client re-derives its horizon from', () => {
    it('lists every held action and no released one', () => {
        const s = createActionStates();
        s.applyEdge({ action: 'left', on: 'press' });
        s.applyEdge({ action: 'jump', on: 'press' });
        s.advanceTick();
        s.applyEdge({ action: 'jump', on: 'release' });
        expect(s.heldActions().toSorted()).toEqual(['left']);
    });

    it('lists only the axes that are off neutral, so a zero costs no wire', () => {
        const s = createActionStates();
        s.applyEdge({ action: 'left', on: 'press', value: 0.5 });
        s.applyEdge({ action: 'right', on: 'press' });
        s.applyEdge({ action: 'right', on: 'release' });
        expect(s.axisValues()).toEqual([{ action: 'left', value: 0.5 }]);
    });
});
