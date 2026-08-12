// Input: edges only, axes on meaningful change, `ackSeq` pruning on RESOLVED, and the
// fold-at-prune horizon that makes a replay sufficient.

import { describe, expect, it } from 'vitest';
import { createActionStates } from '@platform/core';
import type { InputFrame } from '@platform/protocol';
import { BindingTable } from '../src/bindings.js';
import type { Binding } from '../src/bindings.js';
import { AXIS_QUANTUM, RING_TICKS } from '../src/constants.js';
import { InputRing } from '../src/ring.js';

const VIEWPORT = { width: 800, height: 600 };

function table(bindings: readonly Binding[]): BindingTable {
    return new BindingTable(bindings);
}

function frame(tick: number, seq: number, actions: InputFrame['actions'] = []): InputFrame {
    return { kind: 'input', tick, seq, actions };
}

describe('edges only', () => {
    it('a key held across many ticks produces exactly TWO edges', () => {
        const t = table([{ kind: 'button', code: 'keys:KeyW', action: 'jump' }]);
        const edges: string[] = [];
        // 30 "ticks" of holding: one press, no repeats, one release.
        edges.push(
            ...t.resolve({ kind: 'key', code: 'keys:KeyW', down: true }, VIEWPORT).map((e) => e.on),
        );
        for (let i = 0; i < 30; i++) {
            edges.push(
                ...t
                    .resolve({ kind: 'key', code: 'keys:KeyW', down: true }, VIEWPORT)
                    .map((e) => e.on),
            );
        }
        edges.push(
            ...t
                .resolve({ kind: 'key', code: 'keys:KeyW', down: false }, VIEWPORT)
                .map((e) => e.on),
        );
        expect(edges).toEqual(['press', 'release']);
    });

    it('ignores auto-repeat, so a held key is not an edge per event', () => {
        const t = table([{ kind: 'button', code: 'keys:KeyW', action: 'jump' }]);
        t.resolve({ kind: 'key', code: 'keys:KeyW', down: true }, VIEWPORT);
        expect(t.resolve({ kind: 'key', code: 'keys:KeyW', down: true }, VIEWPORT)).toHaveLength(0);
    });

    it('ignores a release for a code that was never down', () => {
        const t = table([{ kind: 'button', code: 'keys:KeyW', action: 'jump' }]);
        expect(t.resolve({ kind: 'key', code: 'keys:KeyW', down: false }, VIEWPORT)).toHaveLength(
            0,
        );
    });

    it('respects the binding context, so a menu key does not fire a gameplay action', () => {
        const t = table([
            { kind: 'button', code: 'keys:KeyW', action: 'jump', context: 'gameplay' },
            { kind: 'button', code: 'keys:KeyW', action: 'menuUp', context: 'menu' },
        ]);
        expect(t.resolve({ kind: 'key', code: 'keys:KeyW', down: true }, VIEWPORT)[0]?.action).toBe(
            'jump',
        );
        t.resolve({ kind: 'key', code: 'keys:KeyW', down: false }, VIEWPORT);
        t.setContext('menu');
        expect(t.resolve({ kind: 'key', code: 'keys:KeyW', down: true }, VIEWPORT)[0]?.action).toBe(
            'menuUp',
        );
    });
});

describe('axes send on meaningful change', () => {
    it('produces nothing for sub-quantum jitter, one edge for a crossing', () => {
        const t = table([{ kind: 'axis', code: 'gamepad:leftStickX', action: 'moveX' }]);
        // First non-neutral sample always sends.
        expect(
            t.resolve({ kind: 'axis', code: 'gamepad:leftStickX', value: 0.5 }, VIEWPORT),
        ).toHaveLength(1);
        // Jitter under the quantum: nothing.
        expect(
            t.resolve(
                { kind: 'axis', code: 'gamepad:leftStickX', value: 0.5 + AXIS_QUANTUM / 4 },
                VIEWPORT,
            ),
        ).toHaveLength(0);
        // A crossing: one.
        expect(
            t.resolve(
                { kind: 'axis', code: 'gamepad:leftStickX', value: 0.5 + AXIS_QUANTUM * 2 },
                VIEWPORT,
            ),
        ).toHaveLength(1);
    });

    it('ALWAYS sends a return to neutral, unquantized', () => {
        // Otherwise a stick released just inside the deadband leaves the server holding a small
        // permanent deflection.
        const t = table([{ kind: 'axis', code: 'gamepad:leftStickX', action: 'moveX' }]);
        t.resolve({ kind: 'axis', code: 'gamepad:leftStickX', value: AXIS_QUANTUM / 2 }, VIEWPORT);
        const neutral = t.resolve({ kind: 'axis', code: 'gamepad:leftStickX', value: 0 }, VIEWPORT);
        expect(neutral).toHaveLength(1);
        expect(neutral[0]?.value).toBe(0);
    });

    it('sends nothing for a neutral axis that was already neutral', () => {
        const t = table([{ kind: 'axis', code: 'gamepad:leftStickX', action: 'moveX' }]);
        expect(
            t.resolve({ kind: 'axis', code: 'gamepad:leftStickX', value: 0 }, VIEWPORT),
        ).toHaveLength(0);
        t.resolve({ kind: 'axis', code: 'gamepad:leftStickX', value: 0.5 }, VIEWPORT);
        t.resolve({ kind: 'axis', code: 'gamepad:leftStickX', value: 0 }, VIEWPORT);
        expect(
            t.resolve({ kind: 'axis', code: 'gamepad:leftStickX', value: 0 }, VIEWPORT),
        ).toHaveLength(0);
    });

    it('drives an axis from a key pair through polarity', () => {
        const t = table([
            { kind: 'axis', code: 'keys:KeyA', action: 'moveX', polarity: -1 },
            { kind: 'axis', code: 'keys:KeyD', action: 'moveX', polarity: 1 },
        ]);
        expect(t.resolve({ kind: 'key', code: 'keys:KeyA', down: true }, VIEWPORT)[0]?.value).toBe(
            -1,
        );
        expect(t.resolve({ kind: 'key', code: 'keys:KeyA', down: false }, VIEWPORT)[0]?.value).toBe(
            0,
        );
        expect(t.resolve({ kind: 'key', code: 'keys:KeyD', down: true }, VIEWPORT)[0]?.value).toBe(
            1,
        );
    });

    it('quantizes cursor axes against the VIEWPORT, so zoom does not change wire volume', () => {
        const bindings: Binding[] = [{ kind: 'cursorX', action: 'aimX' }];
        const zoomedOut = table(bindings);
        const zoomedIn = table([{ kind: 'cursorX', action: 'aimX' }]);

        // Same on-screen movement as a fraction of the view: same number of sends either way.
        const wide = { width: 1600, height: 1200 };
        const narrow = { width: 200, height: 150 };
        zoomedOut.resolve({ kind: 'pointerMove', screenX: 0, screenY: 0 }, wide);
        zoomedIn.resolve({ kind: 'pointerMove', screenX: 0, screenY: 0 }, narrow);

        const wideStep = wide.width * AXIS_QUANTUM * 2;
        const narrowStep = narrow.width * AXIS_QUANTUM * 2;
        expect(
            zoomedOut.resolve({ kind: 'pointerMove', screenX: wideStep, screenY: 0 }, wide),
        ).toHaveLength(1);
        expect(
            zoomedIn.resolve({ kind: 'pointerMove', screenX: narrowStep, screenY: 0 }, narrow),
        ).toHaveLength(1);
        // And a movement below the quantum sends nothing at either zoom.
        expect(
            zoomedOut.resolve({ kind: 'pointerMove', screenX: wideStep + 1, screenY: 0 }, wide),
        ).toHaveLength(0);
    });
});

describe('focus loss releases everything', () => {
    it('emits a synthetic release per held code, in one handler call', () => {
        const t = table([
            { kind: 'button', code: 'keys:KeyA', action: 'left' },
            { kind: 'button', code: 'keys:KeyD', action: 'right' },
            { kind: 'button', code: 'keys:Space', action: 'jump' },
        ]);
        for (const code of ['keys:KeyA', 'keys:KeyD', 'keys:Space']) {
            t.resolve({ kind: 'key', code, down: true }, VIEWPORT);
        }
        const released = t.resolve({ kind: 'focusLost' }, VIEWPORT);
        expect(released).toHaveLength(3);
        expect(released.every((e) => e.on === 'release')).toBe(true);
        expect(released.map((e) => e.action).toSorted()).toEqual(['jump', 'left', 'right']);
    });

    it('releases a code bound in another context, since the held set is context-independent', () => {
        const t = table([
            { kind: 'button', code: 'keys:KeyW', action: 'jump', context: 'gameplay' },
        ]);
        t.resolve({ kind: 'key', code: 'keys:KeyW', down: true }, VIEWPORT);
        t.setContext('menu');
        // Bound only in gameplay, but physically still down — the release must still be produced.
        t.setContext('gameplay');
        expect(t.resolve({ kind: 'focusLost' }, VIEWPORT)).toHaveLength(1);
    });

    it('re-derives from scratch after a reset — the player may have released while away', () => {
        const t = table([{ kind: 'button', code: 'keys:KeyW', action: 'jump' }]);
        t.resolve({ kind: 'key', code: 'keys:KeyW', down: true }, VIEWPORT);
        t.reset();
        expect(t.heldCodes()).toHaveLength(0);
        expect(t.resolve({ kind: 'focusLost' }, VIEWPORT)).toHaveLength(0);
    });

    it('forgetSentValues keeps the held set, so a key held across a resync still releases', () => {
        // Clearing it would swallow the release edge and leave the action held on the server forever.
        const t = table([{ kind: 'button', code: 'keys:KeyW', action: 'jump' }]);
        t.resolve({ kind: 'key', code: 'keys:KeyW', down: true }, VIEWPORT);
        t.forgetSentValues();
        expect(t.heldCodes()).toEqual(['keys:KeyW']);
        expect(t.resolve({ kind: 'key', code: 'keys:KeyW', down: false }, VIEWPORT)).toHaveLength(
            1,
        );
    });

    it('forgetSentValues re-sends an unchanged axis, which the wire no longer knows about', () => {
        const t = table([{ kind: 'axis', code: 'pad:x', action: 'moveX' }]);
        expect(t.resolve({ kind: 'axis', code: 'pad:x', value: 0.5 }, VIEWPORT)).toHaveLength(1);
        // Same value: suppressed as unchanged, which is right until the server forgets it.
        expect(t.resolve({ kind: 'axis', code: 'pad:x', value: 0.5 }, VIEWPORT)).toHaveLength(0);
        t.forgetSentValues();
        expect(t.resolve({ kind: 'axis', code: 'pad:x', value: 0.5 }, VIEWPORT)).toHaveLength(1);
    });
});

describe('rebind replaces buttons only', () => {
    it('keeps an axis binding on the same action, which a player rebinding keys still wants', () => {
        const t = table([
            { kind: 'button', code: 'keys:KeyA', action: 'moveX' },
            { kind: 'axis', code: 'gamepad:leftStickX', action: 'moveX' },
        ]);
        t.rebind('moveX', ['keys:KeyQ']);

        expect(t.resolve({ kind: 'key', code: 'keys:KeyA', down: true }, VIEWPORT)).toHaveLength(0);
        expect(t.resolve({ kind: 'key', code: 'keys:KeyQ', down: true }, VIEWPORT)).toHaveLength(1);
        // The stick survived the keyboard rebind.
        expect(
            t.resolve({ kind: 'axis', code: 'gamepad:leftStickX', value: 0.7 }, VIEWPORT),
        ).toHaveLength(1);
    });

    it('takes effect immediately, so the context-filtered view cannot go stale', () => {
        const t = table([{ kind: 'button', code: 'keys:KeyA', action: 'jump' }]);
        expect(t.resolve({ kind: 'key', code: 'keys:KeyA', down: true }, VIEWPORT)).toHaveLength(1);
        t.rebind('jump', ['keys:KeyB']);
        expect(t.resolve({ kind: 'key', code: 'keys:KeyB', down: true }, VIEWPORT)).toHaveLength(1);
        t.add({ kind: 'button', code: 'keys:KeyC', action: 'crouch' });
        expect(t.resolve({ kind: 'key', code: 'keys:KeyC', down: true }, VIEWPORT)).toHaveLength(1);
    });
});

describe('the ring prunes on RESOLVED', () => {
    it('prunes everything at or below ackSeq and returns the EARLIEST entry pruned', () => {
        const ring = new InputRing();
        for (let i = 0; i < 5; i++) ring.push(frame(100 + i, i), 10 + i, 0);
        const earliest = ring.ack(2);
        // The earliest, NOT the entry at `seq` — the batch's last frame, and the natural reading of
        // the signature, which would pair the compensation with the wrong instant.
        expect(earliest?.frame.seq).toBe(0);
        expect(earliest?.leadAtSendTicks).toBe(10);
        expect(ring.size).toBe(2);
    });

    it('prunes a frame the server REFUSED, and its edges still fold into the horizon', () => {
        const ring = new InputRing();
        ring.push(frame(50, 0, [{ action: 'shoot', on: 'press' }]), 5, 0);
        ring.push(frame(51, 1, []), 5, 0);
        // seq 0 was refused for rate; ackSeq still covers it, because resolved ≠ applied.
        ring.ack(1);
        expect(ring.size).toBe(0);
        expect(ring.heldAtHorizon.held('shoot')).toBe(true);
    });

    it('holds entries when a frame never arrived, since ackSeq cannot pass it', () => {
        const ring = new InputRing();
        ring.push(frame(50, 4), 5, 0);
        ring.push(frame(51, 5), 5, 0); // never arrived at the server
        ring.push(frame(52, 6), 5, 0);
        ring.ack(4); // ackSeq stays at 4
        expect(ring.size).toBe(2);
        expect(ring.oldestSeq).toBe(5);
    });

    it('survives ordinary play without reaching capacity', () => {
        const ring = new InputRing();
        // Several held actions plus a moving cursor over a full round trip — one frame per tick.
        for (let tick = 0; tick < 20; tick++) {
            ring.push(
                frame(tick, tick, [
                    { action: 'moveX', on: 'hold', value: 1 },
                    { action: 'aimX', on: 'hold', value: tick },
                ]),
                5,
                0,
            );
        }
        expect(ring.size).toBeLessThan(RING_TICKS);
        expect(ring.droppedToOverflow).toBe(0);
    });

    it('overflow is diagnostic: oldest dropped, counter incremented, still usable', () => {
        const ring = new InputRing();
        for (let i = 0; i < RING_TICKS + 5; i++) ring.push(frame(i, i), 5, 0);
        expect(ring.size).toBe(RING_TICKS);
        expect(ring.droppedToOverflow).toBe(5);
        // And the dropped frames folded into the horizon rather than vanishing.
        expect(ring.horizonTick).toBe(4);
    });
});

describe('replay sufficiency', () => {
    it('reports X as HELD at 100: press at 50, ack through 100, release at 105', () => {
        // Written exactly this way because press-and-release inside the window, and "press then ask
        // for a tick inside the hold", both pass under the broken designs.
        const ring = new InputRing();
        ring.push(frame(50, 0, [{ action: 'X', on: 'press' }]), 5, 0);
        for (let tick = 51; tick <= 100; tick++) ring.push(frame(tick, tick - 50, []), 5, 0);
        ring.push(frame(105, 56, [{ action: 'X', on: 'release' }]), 5, 0);

        ring.ack(50); // acked through the frame at tick 100

        // `since(100)` is `[release@105]`, and a "last edge per action" map would say `release@105`.
        // NEITHER says X was held at 100 — the horizon fold is what does.
        expect(ring.since(100).map((f) => f.tick)).toEqual([105]);
        expect(ring.heldAtHorizon.held('X')).toBe(true);
    });

    it('the horizon is valid across an idle gap, as an INTERVAL not an equality', () => {
        // `horizonTick` is the last PRUNED frame's tick, while prediction restores to the acked
        // ENVELOPE's tick; across an input-idle gap those differ, so an equality assertion would fail
        // for a reason that looks like a bug in the fold.
        const ring = new InputRing();
        ring.push(frame(50, 0, [{ action: 'X', on: 'press' }]), 5, 0);
        ring.push(frame(80, 1, []), 5, 0);
        ring.ack(0);

        expect(ring.horizonTick).toBe(50);
        expect(ring.horizonValidUntil).toBe(80);
        // Sound for ANY tick in [50, 80): an edge in the gap would have been pruned too and folded in.
        for (const tick of [50, 60, 79]) {
            expect(tick).toBeGreaterThanOrEqual(ring.horizonTick);
            expect(tick).toBeLessThan(ring.horizonValidUntil);
        }
        expect(ring.heldAtHorizon.held('X')).toBe(true);
    });

    it('a release inside the pruned range clears the hold', () => {
        const ring = new InputRing();
        ring.push(frame(50, 0, [{ action: 'X', on: 'press' }]), 5, 0);
        ring.push(frame(55, 1, [{ action: 'X', on: 'release' }]), 5, 0);
        ring.ack(1);
        expect(ring.heldAtHorizon.held('X')).toBe(false);
    });

    it('a resync rebuilds the horizon from the LIVE action state, in the new numbering', () => {
        const ring = new InputRing();
        ring.push(frame(50, 0, [{ action: 'old', on: 'press' }]), 5, 0);
        ring.ack(0);
        expect(ring.heldAtHorizon.held('old')).toBe(true);

        const live = createActionStates();
        live.applyEdge({ action: 'W', on: 'press' });
        live.applyEdge({ action: 'moveX', on: 'hold', value: 0.75 });
        ring.reset(live);

        expect(ring.size).toBe(0);
        expect(ring.horizonTick).toBe(-1);
        expect(ring.heldAtHorizon.held('old')).toBe(false);
        // What is physically held did not change because the session's clock did.
        expect(ring.heldAtHorizon.held('W')).toBe(true);
        expect(ring.heldAtHorizon.axis('moveX')).toBe(0.75);
        // And a rebuilt horizon asserts held state, not a transition.
        expect(ring.heldAtHorizon.pressed('W')).toBe(false);
    });
});

describe('ActionState edges are one tick wide', () => {
    it('clears pressed/released on advanceTick while keeping held and axis', () => {
        const s = createActionStates();
        s.applyEdge({ action: 'jump', on: 'press' });
        expect(s.pressed('jump')).toBe(true);
        expect(s.held('jump')).toBe(true);
        expect(s.axis('jump')).toBe(1);

        s.advanceTick();
        expect(s.pressed('jump')).toBe(false);
        expect(s.held('jump')).toBe(true); // survives

        s.applyEdge({ action: 'jump', on: 'release' });
        expect(s.released('jump')).toBe(true);
        expect(s.held('jump')).toBe(false);
        expect(s.axis('jump')).toBe(0);

        s.advanceTick();
        expect(s.released('jump')).toBe(false);
    });

    it('a hold sample updates the axis without asserting an edge', () => {
        const s = createActionStates();
        s.applyEdge({ action: 'moveX', on: 'hold', value: 0.5 });
        expect(s.axis('moveX')).toBe(0.5);
        // A hold must not set `pressed`, which is one tick wide by definition, and must not add to
        // `held` on its own — an axis returning to neutral is a hold, not a release.
        expect(s.pressed('moveX')).toBe(false);
        expect(s.held('moveX')).toBe(false);
    });

    it('reports held actions and non-neutral axes, for the horizon rebuild', () => {
        const s = createActionStates();
        s.applyEdge({ action: 'a', on: 'press' });
        s.applyEdge({ action: 'b', on: 'press' });
        s.applyEdge({ action: 'b', on: 'release' });
        s.applyEdge({ action: 'moveX', on: 'hold', value: 0.25 });
        s.applyEdge({ action: 'moveY', on: 'hold', value: 0 });
        expect(s.heldActions().toSorted()).toEqual(['a']);
        expect(
            s
                .axisValues()
                .map((v) => v.action)
                .toSorted(),
        ).toEqual(['a', 'moveX']);
    });
});
