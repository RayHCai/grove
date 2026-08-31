// The canvas input adapter: viewport pixels in, canvas pixels and world units out.
//
// No DOM environment here, so `window`, `document` and the container are hand-rolled listener
// registries — which is also the only way to assert that dispose actually unregisters.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RawInputEvent } from '../src/input.js';
import type { CanvasPress } from '../src/browser/canvas-input.js';
import { canvasPoint, createCanvasInputDevice } from '../src/browser/canvas-input.js';

/** A listener registry that records what is on it, so a removal is observable. */
class FakeTarget {
    readonly listeners = new Map<string, Set<(e: unknown) => void>>();

    addEventListener(type: string, fn: (e: unknown) => void): void {
        let set = this.listeners.get(type);
        if (set === undefined) {
            set = new Set();
            this.listeners.set(type, set);
        }
        set.add(fn);
    }

    removeEventListener(type: string, fn: (e: unknown) => void): void {
        this.listeners.get(type)?.delete(fn);
    }

    fire(type: string, event: unknown): void {
        // Copied first: a listener that disposes the device mutates the set being walked.
        const held = [...(this.listeners.get(type) ?? [])];
        for (const fn of held) fn(event);
    }

    get count(): number {
        let total = 0;
        for (const set of this.listeners.values()) total += set.size;
        return total;
    }
}

/** The container the canvas fills: a 40px-inset box with a 2px border. */
class FakeContainer extends FakeTarget {
    left = 40;
    top = 10;
    clientLeft = 2;
    clientTop = 3;

    getBoundingClientRect(): { left: number; top: number } {
        return { left: this.left, top: this.top };
    }
}

let container: FakeContainer;
let fakeWindow: FakeTarget;
let fakeDocument: FakeTarget & { visibilityState: string };

beforeEach(() => {
    container = new FakeContainer();
    fakeWindow = new FakeTarget();
    fakeDocument = Object.assign(new FakeTarget(), { visibilityState: 'visible' });
    (globalThis as Record<string, unknown>).window = fakeWindow;
    (globalThis as Record<string, unknown>).document = fakeDocument;
});

afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).document;
});

/** A camera that halves and flips: canvas y-down becomes world y-up, so the sign is observable. */
const renderer = {
    screenToWorld(point: { x: number; y: number }): { x: number; y: number } {
        return { x: point.x / 2, y: -point.y / 2 };
    },
};

interface Harness {
    device: ReturnType<typeof createCanvasInputDevice>;
    seen: RawInputEvent[];
    presses: CanvasPress[];
    dispose: () => void;
}

function harness(opts: { pointerMoves?: boolean } = {}): Harness {
    const seen: RawInputEvent[] = [];
    const presses: CanvasPress[] = [];
    const device = createCanvasInputDevice({
        container: container as unknown as HTMLElement,
        renderer,
        // Spread rather than passed: `exactOptionalPropertyTypes` distinguishes an absent optional
        // from one explicitly set to undefined.
        ...(opts.pointerMoves === undefined ? {} : { pointerMoves: opts.pointerMoves }),
        onPress: (press) => presses.push(press),
    });
    const dispose = device.onRaw((event) => seen.push(event));
    return { device, seen, presses, dispose };
}

function pointerEvent(x: number, y: number, button = 0): unknown {
    return { button, clientX: x, clientY: y };
}

describe('coordinate conversion', () => {
    it('reports a press in canvas pixels, with the border taken off', () => {
        const h = harness();
        // 140 - 40 (rect) - 2 (border) = 98; 210 - 10 - 3 = 197.
        container.fire('pointerdown', pointerEvent(140, 210));
        expect(h.presses).toHaveLength(1);
        expect(h.presses[0]?.canvasX).toBe(98);
        expect(h.presses[0]?.canvasY).toBe(197);
    });

    it('reports the same press in world units, through the renderer', () => {
        const h = harness();
        container.fire('pointerdown', pointerEvent(140, 210));
        expect(h.presses[0]?.worldX).toBe(49);
        expect(h.presses[0]?.worldY).toBe(-98.5);
    });

    it('carries the button through, so a right-click is distinguishable', () => {
        const h = harness();
        container.fire('pointerdown', pointerEvent(40, 10, 2));
        expect(h.presses[0]?.button).toBe(2);
    });

    it('reads the rect per press, so a resized or scrolled container stays right', () => {
        const h = harness();
        container.fire('pointerdown', pointerEvent(140, 210));
        container.left = 90;
        container.fire('pointerdown', pointerEvent(140, 210));
        expect(h.presses[0]?.canvasX).toBe(98);
        expect(h.presses[1]?.canvasX).toBe(48);
    });

    it('still reports canvas pixels when the camera yields no world point', () => {
        const presses: CanvasPress[] = [];
        const device = createCanvasInputDevice({
            container: container as unknown as HTMLElement,
            renderer: { screenToWorld: () => ({ x: Number.NaN, y: Number.NaN }) },
            onPress: (p) => presses.push(p),
        });
        device.onRaw(() => {});
        container.fire('pointerdown', pointerEvent(140, 210));
        // Picking works off a degenerate camera; only the wire needs the finite check.
        expect(presses[0]?.canvasX).toBe(98);
        expect(Number.isNaN(presses[0]?.worldX ?? 0)).toBe(true);
    });

    it('exports the same conversion on its own, for a caller holding no device', () => {
        expect(canvasPoint(container as unknown as HTMLElement, 140, 210)).toEqual({
            x: 98,
            y: 197,
        });
    });
});

describe('what reaches the client', () => {
    it('runs onPress BEFORE forwarding the press, so an emitted axis leads the button', () => {
        const order: string[] = [];
        const device = createCanvasInputDevice({
            container: container as unknown as HTMLElement,
            renderer,
            onPress: () => {
                order.push('axis');
                device.emit({ kind: 'axis', code: 'aim', value: 1 });
            },
        });
        device.onRaw((event) => order.push(event.kind === 'axis' ? 'emitted' : event.kind));
        container.fire('pointerdown', pointerEvent(140, 210));
        expect(order).toEqual(['axis', 'emitted', 'pointer']);
    });

    it('does not call onPress for a release', () => {
        const h = harness();
        container.fire('pointerup', pointerEvent(140, 210));
        expect(h.presses).toHaveLength(0);
        expect(h.seen.map((e) => e.kind)).toEqual(['pointer']);
    });

    it('drops pointerMove by default', () => {
        const h = harness();
        container.fire('pointermove', pointerEvent(140, 210));
        expect(h.seen).toHaveLength(0);
    });

    it('forwards pointerMove when the game aims continuously', () => {
        const h = harness({ pointerMoves: true });
        container.fire('pointermove', pointerEvent(140, 210));
        expect(h.seen.map((e) => e.kind)).toEqual(['pointerMove']);
    });

    it('passes keys and focus loss through untouched', () => {
        const h = harness();
        fakeWindow.fire('keydown', { code: 'KeyW', repeat: false });
        fakeWindow.fire('blur', {});
        expect(h.seen).toEqual([
            { kind: 'key', code: 'keys:KeyW', down: true },
            { kind: 'focusLost' },
        ]);
    });

    it('forwards emit, so a polled gamepad feeds the same handler', () => {
        const h = harness();
        h.device.emit({ kind: 'axis', code: 'gamepad:axis0', value: 0.5 });
        expect(h.seen).toEqual([{ kind: 'axis', code: 'gamepad:axis0', value: 0.5 }]);
    });
});

describe('teardown', () => {
    it('unregisters every DOM listener, and is idempotent', () => {
        const h = harness();
        expect(container.count + fakeWindow.count + fakeDocument.count).toBeGreaterThan(0);
        h.device.dispose();
        h.device.dispose();
        expect(container.count + fakeWindow.count + fakeDocument.count).toBe(0);
    });

    it('stops converting once the handler disposer has run', () => {
        const h = harness();
        h.dispose();
        container.fire('pointerdown', pointerEvent(140, 210));
        expect(h.seen).toHaveLength(0);
        // `onPress` goes quiet with it, deliberately: it is the same subscription, and a callback
        // still firing for a device nobody reads is a leak wearing a coordinate.
        expect(h.presses).toHaveLength(0);
    });
});
