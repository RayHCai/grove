// The context guard's state machine and queue semantics (§10).
//
// Runs in Node with no WebGL: the guard listens on a canvas-shaped EventTarget and drives the
// restore through injected hooks, so everything below the GPU boundary is exercised for real. The
// two things that genuinely need a browser — that Pixi re-uploads correctly, and that a real
// `webglcontextlost` fires — are §15's named browser-mode tests.

import { describe, it, expect } from 'vitest';
import { AssetQueue } from '../src/asset-queue.js';
import { CANCELLED_REASON, ContextGuard } from '../src/pixi/context-guard.js';
import type { AssetManifestEntry } from '../src/renderer.js';
import type { MergedAssetWork } from '../src/asset-queue.js';

/** A canvas stand-in: the guard only ever calls add/removeEventListener on it. */
function fakeCanvas(): HTMLCanvasElement & { fire: (type: string) => Event } {
    const target = new EventTarget();
    const canvas = {
        addEventListener: target.addEventListener.bind(target),
        removeEventListener: target.removeEventListener.bind(target),
        fire(type: string): Event {
            // `cancelable` matters: preventDefault on a non-cancelable event is a silent no-op,
            // and this test asserts the flag actually flips.
            const event = new Event(type, { cancelable: true });
            target.dispatchEvent(event);
            return event;
        },
    };
    return canvas as unknown as HTMLCanvasElement & { fire: (type: string) => Event };
}

interface Harness {
    guard: ContextGuard;
    queue: AssetQueue;
    canvas: ReturnType<typeof fakeCanvas>;
    retained: Map<string, AssetManifestEntry>;
    /** Every merge the restore performed, in order. */
    merges: MergedAssetWork[];
    lost: string[];
    restored: Array<{ reloadedAssets: string[]; failedAssets: string[] }>;
    rebuilds: number;
    /** Names the fake uploader should report as failures. */
    failNames: Set<string>;
}

function harness(deviceLost?: Promise<unknown>): Harness {
    const queue = new AssetQueue();
    const state: Harness = {
        guard: undefined as unknown as ContextGuard,
        queue,
        canvas: fakeCanvas(),
        retained: new Map(),
        merges: [],
        lost: [],
        restored: [],
        rebuilds: 0,
        failNames: new Set(),
    };

    state.guard = new ContextGuard(queue, {
        retainedManifest: () => state.retained,
        reupload: async (work) => {
            state.merges.push(work);
            const reloaded: string[] = [];
            const failed: string[] = [];
            for (const entry of work.toLoad) {
                if (state.failNames.has(entry.name)) failed.push(entry.name);
                else reloaded.push(entry.name);
            }
            return { reloaded, failed };
        },
        rebuildScene: () => {
            state.rebuilds++;
        },
        onLost: (reason) => state.lost.push(reason),
        onRestored: (reloadedAssets, failedAssets) =>
            state.restored.push({ reloadedAssets, failedAssets }),
    });
    state.guard.install(state.canvas, deviceLost);
    return state;
}

const image = (name: string): AssetManifestEntry => ({
    name,
    kind: 'image',
    url: `/${name}.png`,
});

/** Lets the guard's async restore chain settle. */
async function settle(): Promise<void> {
    await new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
}

describe('ContextGuard — state machine', () => {
    it("starts 'ok' and not lost", () => {
        const h = harness();
        expect(h.guard.state).toBe('ok');
        expect(h.guard.lost).toBe(false);
        expect(h.guard.pendingCount).toBe(0);
    });

    it("enters 'lost' and emits on webglcontextlost", () => {
        const h = harness();
        h.canvas.fire('webglcontextlost');

        expect(h.guard.state).toBe('lost');
        expect(h.guard.lost).toBe(true);
        expect(h.lost).toEqual(['webglcontextlost']);
    });

    it('calls preventDefault on webglcontextlost — MANDATORY (§10, §15)', () => {
        const h = harness();
        const event = h.canvas.fire('webglcontextlost');

        // Without preventDefault the browser NEVER fires webglcontextrestored, so a restore
        // would never happen. This is the classic gotcha §10 calls out by name.
        expect(event.defaultPrevented).toBe(true);
    });

    it('ignores a repeated loss while already lost', () => {
        const h = harness();
        h.canvas.fire('webglcontextlost');
        h.canvas.fire('webglcontextlost');
        expect(h.lost).toHaveLength(1);
    });

    it("returns to 'ok' and emits contextrestored", async () => {
        const h = harness();
        h.retained.set('hero', image('hero'));
        h.canvas.fire('webglcontextlost');
        h.canvas.fire('webglcontextrestored');
        await settle();

        expect(h.guard.state).toBe('ok');
        expect(h.rebuilds).toBe(1);
        expect(h.restored).toEqual([{ reloadedAssets: ['hero'], failedAssets: [] }]);
    });

    it('reports failed reloads — a loss during a network outage is real (§10)', async () => {
        const h = harness();
        h.retained.set('hero', image('hero'));
        h.retained.set('gone', image('gone'));
        h.failNames.add('gone');

        h.canvas.fire('webglcontextlost');
        h.canvas.fire('webglcontextrestored');
        await settle();

        expect(h.restored[0]?.reloadedAssets).toEqual(['hero']);
        expect(h.restored[0]?.failedAssets).toEqual(['gone']);
    });

    it('folds a WebGPU device loss into the same path (§10)', async () => {
        let resolveLost: (() => void) | undefined;
        const deviceLost = new Promise<void>((resolve) => {
            resolveLost = resolve;
        });
        const h = harness(deviceLost);

        resolveLost?.();
        await settle();

        // The backend difference is not the caller's business: same state, same event.
        expect(h.guard.state).toBe('lost');
        expect(h.lost).toEqual(['GPUDevice.lost']);
    });
});

describe('ContextGuard — queueing (§10)', () => {
    it('runs an operation immediately while the context is fine', async () => {
        const h = harness();
        let ran = false;

        const result = await h.guard.run(async () => {
            ran = true;
            return 'done';
        });

        expect(ran).toBe(true);
        expect(result).toBe('done');
    });

    it('defers an operation while lost and resolves it after restore', async () => {
        const h = harness();
        h.canvas.fire('webglcontextlost');

        let ran = false;
        const promise = h.guard.run(async () => {
            ran = true;
            return 'later';
        });

        // Store mutations apply immediately; GPU operations QUEUE — so nothing has run yet, and
        // the caller is still holding an unresolved promise rather than an error.
        expect(ran).toBe(false);
        expect(h.guard.pendingCount).toBe(1);

        h.canvas.fire('webglcontextrestored');
        await expect(promise).resolves.toBe('later');
        expect(ran).toBe(true);
        expect(h.guard.pendingCount).toBe(0);
    });

    it('runs queued work only AFTER the manifest is back', async () => {
        const h = harness();
        h.retained.set('hero', image('hero'));
        h.canvas.fire('webglcontextlost');

        const order: string[] = [];
        void h.guard.run(async () => {
            order.push('queued-op');
            return 0;
        });

        h.canvas.fire('webglcontextrestored');
        await settle();

        // A queued op that references a just-restored asset must find it, so the re-upload and
        // the scene rebuild both precede it.
        expect(h.merges).toHaveLength(1);
        expect(order).toEqual(['queued-op']);
        expect(h.rebuilds).toBe(1);
    });

    it('settles queued promises as cancelled on destroy rather than rejecting (§10)', async () => {
        const h = harness();
        h.canvas.fire('webglcontextlost');

        const promise = h.guard.run(async () => 'never');
        expect(h.guard.pendingCount).toBe(1);

        h.guard.destroy(() => ({ cancelled: CANCELLED_REASON }));

        // Rejecting here would produce an unhandled rejection during ordinary teardown.
        await expect(promise).resolves.toEqual({ cancelled: CANCELLED_REASON });
        expect(h.guard.pendingCount).toBe(0);
    });

    it('stops listening after destroy', () => {
        const h = harness();
        h.guard.destroy(() => undefined);
        h.canvas.fire('webglcontextlost');
        expect(h.lost).toEqual([]);
    });
});

describe('ContextGuard — restore merge order (§10)', () => {
    it('lets a queued unload SUPPRESS a retained re-upload', async () => {
        const h = harness();
        h.retained.set('level1', image('level1'));
        h.retained.set('shared', image('shared'));

        h.canvas.fire('webglcontextlost');
        // A level transition mid-loss: drop level1, keep shared.
        h.queue.unload('level1');

        h.canvas.fire('webglcontextrestored');
        await settle();

        const merge = h.merges[0];
        // The reverse order — re-upload everything retained, then drain the queue — would
        // RESURRECT level1 and pay for it every frame after.
        expect(merge?.toLoad.map((entry) => entry.name)).toEqual(['shared']);
        expect(merge?.toUnload).toEqual(['level1']);
        expect(h.restored[0]?.reloadedAssets).toEqual(['shared']);
    });

    it('adds a queued load that was never resident', async () => {
        const h = harness();
        h.retained.set('old', image('old'));

        h.canvas.fire('webglcontextlost');
        h.queue.load(image('new'));
        h.canvas.fire('webglcontextrestored');
        await settle();

        expect(h.merges[0]?.toLoad.map((entry) => entry.name)).toEqual(['old', 'new']);
    });

    it('prefers the queued entry over a retained one of the same name', async () => {
        const h = harness();
        h.retained.set('hero', image('hero'));
        const updated: AssetManifestEntry = {
            name: 'hero',
            kind: 'image',
            url: '/hero-v2.png',
        };

        h.canvas.fire('webglcontextlost');
        h.queue.load(updated);
        h.canvas.fire('webglcontextrestored');
        await settle();

        const loaded = h.merges[0]?.toLoad;
        expect(loaded).toHaveLength(1);
        // The queued declaration is newer — a changed url must win.
        expect(loaded?.[0]).toBe(updated);
    });

    it('collapses load -> unload -> load into a net load', async () => {
        const h = harness();
        h.canvas.fire('webglcontextlost');
        h.queue.load(image('a'));
        h.queue.unload('a');
        h.queue.load(image('a'));

        h.canvas.fire('webglcontextrestored');
        await settle();

        // An intent MAP, not a log: thrashing a name across a long loss costs one entry.
        expect(h.merges[0]?.toLoad.map((entry) => entry.name)).toEqual(['a']);
        expect(h.merges[0]?.toUnload).toEqual([]);
    });

    it('drains the queue so a second loss does not replay the first', async () => {
        const h = harness();
        h.canvas.fire('webglcontextlost');
        h.queue.load(image('once'));
        h.canvas.fire('webglcontextrestored');
        await settle();

        h.canvas.fire('webglcontextlost');
        h.canvas.fire('webglcontextrestored');
        await settle();

        expect(h.merges[1]?.toLoad).toEqual([]);
        expect(h.queue.size).toBe(0);
    });
});
