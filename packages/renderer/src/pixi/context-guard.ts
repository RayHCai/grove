// Store mutations apply immediately while GPU operations queue, so the client's frame loop needs no
// branch and no caller needs a rebuild path: node ids survive a loss because the store is the source
// of truth and the Pixi objects are derived from it.
//
//   webglcontextlost  ->  preventDefault()  ->  'lost'  ->  emit 'contextlost'
//   webglcontextrestored / GPUDevice.lost
//                     ->  'restoring'
//                     ->  merge retained manifest with queued intents, re-upload
//                     ->  recreate the xform/art pairs from our node records, mark all dirty
//                     ->  'ok'  ->  emit 'contextrestored'
//
// `preventDefault()` on `webglcontextlost` is mandatory: without it the browser never fires
// `webglcontextrestored`. Pixi's own handler already calls it and a second call is idempotent, so
// this guard keeps the guarantee even if that handler is ever reordered.

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

/** A queued GPU operation plus its resolver, so `destroy()` can cancel rather than reject. */
interface PendingOp<T> {
    resolve: (value: T) => void;
    /** Runs the real work once the context is back. */
    run: () => Promise<T>;
}

/** The reason string used when `destroy()` settles a queued operation. */
export const CANCELLED_REASON = 'renderer destroyed before the context was restored';

/**
 * Tracks context state, queues GPU work while it is gone, and drives the restore.
 *
 * WebGPU device loss folds into the same callbacks, since the difference is not a caller's business.
 */
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

    /** Starts listening on the canvas. Safe to call once per init. */
    install(canvas: HTMLCanvasElement, gpuDeviceLost?: Promise<unknown>): void {
        this.#canvas = canvas;
        canvas.addEventListener('webglcontextlost', this.#onLost, false);
        canvas.addEventListener('webglcontextrestored', this.#onRestored, false);

        // WebGPU has no DOM event for this, only a `lost` promise, folded into the same state
        // machine so the two look identical from outside.
        if (gpuDeviceLost !== undefined) {
            void gpuDeviceLost.then(() => {
                if (!this.#destroyed) this.#enterLost('GPUDevice.lost');
            });
        }
    }

    /** Runs `op` now, or queues it until the context is back. The promise resolves either way. */
    run<T>(op: () => Promise<T>): Promise<T> {
        if (!this.lost) return op();

        return new Promise<T>((resolve) => {
            this.#pending.push({
                resolve: resolve as (value: unknown) => void,
                run: op as () => Promise<unknown>,
            });
        });
    }

    /** Settles queued operations as cancelled rather than rejecting, so teardown stays quiet. */
    destroy(cancelledValue: () => unknown): void {
        this.#destroyed = true;
        if (this.#canvas !== null) {
            this.#canvas.removeEventListener('webglcontextlost', this.#onLost);
            this.#canvas.removeEventListener('webglcontextrestored', this.#onRestored);
            this.#canvas = null;
        }
        const pending = this.#pending.splice(0, this.#pending.length);
        for (const op of pending) op.resolve(cancelledValue());
    }

    #enterLost(reason: string): void {
        if (this.#state === 'lost' || this.#destroyed) return;
        this.#state = 'lost';
        this.#hooks.onLost(reason);
    }

    async #restore(): Promise<void> {
        if (this.#destroyed || this.#state === 'ok') return;
        this.#state = 'restoring';

        // Merge order is load-bearing: merging before applying is what lets a queued unload
        // suppress a re-upload of something that was resident before the loss.
        const work = this.#queue.merge(this.#hooks.retainedManifest());
        this.#queue.clear();

        const { reloaded, failed } = await this.#hooks.reupload(work);

        // The pairs are derived from our records, so this needs nothing from the caller.
        this.#hooks.rebuildScene();

        // After the manifest is back, so an op referencing a just-restored asset finds it.
        const pending = this.#pending.splice(0, this.#pending.length);
        for (const op of pending) op.resolve(await op.run());

        this.#state = 'ok';
        this.#hooks.onRestored(reloaded, failed);
    }
}
