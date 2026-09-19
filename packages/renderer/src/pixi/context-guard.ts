// webglcontextlost → preventDefault → 'lost'; restored → 'restoring' → merge the retained
// manifest with queued intents, re-upload, recreate xform/art pairs, mark all dirty → 'ok'.
// Pixi's own handler already calls `preventDefault()`; a second call is idempotent.

import type { ContextState } from '../renderer.js';
import type { AssetQueue } from '../asset-queue.js';
import type { MergedAssetWork } from '../asset-queue.js';
import type { AssetManifestEntry } from '../renderer.js';

/** What the guard needs from the renderer to drive a restore. */
export interface ContextGuardHooks {
    /** The retained manifest, for the merge. */
    retainedManifest: () => ReadonlyMap<string, AssetManifestEntry>;
    /** Re-uploads the merged work and reports what came back. */
    reupload: (work: MergedAssetWork) => Promise<{ reloaded: string[]; failed: string[] }>;
    /** Recreates the xform/art pairs from our node records, then marks everything dirty. */
    rebuildScene: () => void;
    onLost: (reason: string) => void;
    onRestored: (reloadedAssets: string[], failedAssets: string[]) => void;
}

/** A queued GPU operation, its resolver, and what to settle with when it cannot run. */
interface PendingOp<T> {
    resolve: (value: T) => void;
    run: () => Promise<T>;
    cancelled: () => T;
}

/** The reason string used when a queued operation cannot run. */
export const CANCELLED_REASON = 'renderer destroyed before the context was restored';

/** Queued operations allowed while the context is gone; past the cap one settles as cancelled. */
const MAX_PENDING = 1024;

/** Tracks context state, queues GPU work while it is gone, and drives the restore. */
export class ContextGuard {
    #state: ContextState = 'ok';
    #canvas: HTMLCanvasElement | null = null;
    #destroyed = false;

    /** Queued operations, in call order. Bounded by what the caller asked for. */
    readonly #pending: Array<PendingOp<unknown>> = [];

    readonly #queue: AssetQueue;
    readonly #hooks: ContextGuardHooks;

    readonly #onLost = (event: Event): void => {
        // Without this the browser never fires `webglcontextrestored`.
        event.preventDefault();
        this.#enterLost('webglcontextlost');
    };

    readonly #onRestored = (): void => {
        void this.#restore();
    };

    constructor(queue: AssetQueue, hooks: ContextGuardHooks) {
        this.#queue = queue;
        this.#hooks = hooks;
    }

    get state(): ContextState {
        return this.#state;
    }

    /** `true` while GPU work must queue rather than run. */
    get lost(): boolean {
        return this.#state !== 'ok';
    }

    /** Queued GPU operations — feeds `pendingAssetOps`. */
    get pendingCount(): number {
        return this.#pending.length;
    }

    /** Starts listening on the canvas. Call once per init; a second call rebinds. */
    install(canvas: HTMLCanvasElement, gpuDeviceLost?: Promise<unknown>): void {
        this.#unbind();
        this.#canvas = canvas;
        canvas.addEventListener('webglcontextlost', this.#onLost, false);
        canvas.addEventListener('webglcontextrestored', this.#onRestored, false);

        // A lost WebGPU device is terminal: there is no restore event, and the adapter hands back a
        // new device only to a new renderer. So queued work is settled rather than left hanging,
        // and `contextState` stays `'lost'` for the life of this instance.
        if (gpuDeviceLost !== undefined) {
            void gpuDeviceLost.then(() => {
                if (this.#destroyed) return;
                this.#enterLost('GPUDevice.lost');
                this.#settlePending();
            });
        }
    }

    /** Runs `op` now, or queues it until the context is back; the promise resolves either way. */
    run<T>(op: () => Promise<T>, cancelled: () => T): Promise<T> {
        if (!this.lost) return op();
        if (this.#pending.length >= MAX_PENDING) return Promise.resolve(cancelled());

        return new Promise<T>((resolve) => {
            this.#pending.push({
                resolve: resolve as (value: unknown) => void,
                run: op as () => Promise<unknown>,
                cancelled: cancelled as () => unknown,
            });
        });
    }

    /** Settles queued operations as cancelled rather than rejecting, so teardown stays quiet. */
    destroy(): void {
        this.#destroyed = true;
        this.#unbind();
        this.#settlePending();
    }

    #unbind(): void {
        if (this.#canvas === null) return;
        this.#canvas.removeEventListener('webglcontextlost', this.#onLost);
        this.#canvas.removeEventListener('webglcontextrestored', this.#onRestored);
        this.#canvas = null;
    }

    /** Drains the queue, settling every operation with its own cancelled value. */
    #settlePending(): void {
        const pending = this.#pending.splice(0, this.#pending.length);
        for (const op of pending) op.resolve(op.cancelled());
    }

    #enterLost(reason: string): void {
        if (this.#state === 'lost' || this.#destroyed) return;
        // Reachable from `'restoring'` too: a loss during a restore invalidates it, and #restore
        // checks for that before claiming the context is back.
        this.#state = 'lost';
        this.#hooks.onLost(reason);
    }

    /**
     * Re-uploads, rebuilds and drains, then reports the context back.
     * Every step is contained: a throw must not strand the state at `'restoring'`, which is final.
     */
    async #restore(): Promise<void> {
        if (this.#destroyed || this.#state === 'ok' || this.#state === 'restoring') return;
        this.#state = 'restoring';

        const failures: string[] = [];
        let reloaded: string[] = [];
        try {
            // Merge order is load-bearing: merging before applying is what lets a queued unload
            // suppress a re-upload of something that was resident before the loss.
            const work = this.#queue.merge(this.#hooks.retainedManifest());
            this.#queue.clear();

            const outcome = await this.#hooks.reupload(work);
            reloaded = outcome.reloaded;
            failures.push(...outcome.failed);

            if (this.#destroyed) return;
            // The pairs are derived from our records, so this needs nothing from the caller.
            this.#hooks.rebuildScene();

            // After the manifest is back, so an op referencing a just-restored asset finds it, and
            // in a loop because an op that lands mid-drain would otherwise never run.
            while (this.#pending.length > 0 && !this.#destroyed) {
                const op = this.#pending.shift();
                if (op === undefined) break;
                try {
                    op.resolve(await op.run());
                } catch {
                    op.resolve(op.cancelled());
                }
            }
        } catch (error) {
            failures.push(error instanceof Error ? error.message : String(error));
            this.#settlePending();
        } finally {
            if (!this.#destroyed) {
                // A second loss during the restore leaves the state alone: the context is genuinely
                // gone again, and its own restore event will drive the next attempt.
                if (this.#state === 'restoring') this.#state = 'ok';
                this.#hooks.onRestored(reloaded, failures);
            }
        }
    }
}
