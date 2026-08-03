// Context loss and restore (§10).
//
// THE SPLIT THAT MAKES THIS WORK: store mutations apply immediately, GPU operations queue. So the
// client's frame loop needs no branch, and NO CALLER NEEDS A REBUILD PATH — node ids survive a
// loss, because the store is the source of truth and the Pixi objects are derived (§6).
//
//   webglcontextlost   ->  preventDefault()  ->  'lost'  ->  emit 'contextlost'
//   webglcontextrestored / GPUDevice.lost resolution
//                      ->  'restoring'
//                      ->  merge retained manifest + queued intents; re-upload
//                      ->  recreate xform/art pairs from our node records
//                      ->  mark all dirty; full flush
//                      ->  'ok'  ->  emit 'contextrestored' { reloadedAssets, failedAssets }
//
// `preventDefault()` on `webglcontextlost` is MANDATORY: without it the browser never fires
// `webglcontextrestored`. Pixi's own `GlContextSystem.handleContextLost` already calls it, and
// calling it again is idempotent — so this guard both observes the event and keeps the guarantee
// even if the backend's own handler is ever reordered.
//
// RESTORE MERGES THE RETAINED MANIFEST WITH THE QUEUE **before** applying, so a queued unload
// SUPPRESSES re-upload of something resident before the loss. The reverse order resurrects assets
// a level transition meant to drop, and every frame after would pay for them.

import type { ContextState } from '../renderer.js';
import type { AssetQueue } from '../asset-queue.js';
import type { MergedAssetWork } from '../asset-queue.js';
import type { AssetManifestEntry } from '../renderer.js';

/** What the guard needs from the renderer to drive a restore. */
export interface ContextGuardHooks {
    /** The retained manifest, for the merge (§10). */
    retainedManifest: () => ReadonlyMap<string, AssetManifestEntry>;
    /** Re-uploads the merged work and reports what came back. */
    reupload: (work: MergedAssetWork) => Promise<{ reloaded: string[]; failed: string[] }>;
    /** Recreates the xform/art pairs from our node records, then marks everything dirty. */
    rebuildScene: () => void;
    onLost: (reason: string) => void;
    onRestored: (reloadedAssets: string[], failedAssets: string[]) => void;
}

/** A queued GPU operation's settlement, so `destroy()` can cancel rather than reject (§10). */
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
 * WebGPU device loss folds into the same two callbacks — the backend difference is not the
 * caller's business (§10).
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
        // MANDATORY: without preventDefault the browser never fires `webglcontextrestored`
        // (§10). Idempotent alongside Pixi's own handler.
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

    /** Queued GPU operations — feeds `pendingAssetOps` (§11). */
    get pendingCount(): number {
        return this.#pending.length;
    }

    /** Starts listening on the canvas. Safe to call once per init. */
    install(canvas: HTMLCanvasElement, gpuDeviceLost?: Promise<unknown>): void {
        this.#canvas = canvas;
        canvas.addEventListener('webglcontextlost', this.#onLost, false);
        canvas.addEventListener('webglcontextrestored', this.#onRestored, false);

        // WebGPU has no DOM event for this: the device exposes a `lost` promise instead. Folded
        // into the same state machine so the two backends look identical from outside (§10).
        if (gpuDeviceLost !== undefined) {
            void gpuDeviceLost.then(() => {
                if (!this.#destroyed) this.#enterLost('GPUDevice.lost');
            });
        }
    }

    /**
     * Runs `op` now, or queues it until the context is back.
     *
     * The returned promise resolves either way, so a caller mid-loss never has to branch (§10).
     */
    run<T>(op: () => Promise<T>): Promise<T> {
        if (!this.lost) return op();

        return new Promise<T>((resolve) => {
            this.#pending.push({
                resolve: resolve as (value: unknown) => void,
                run: op as () => Promise<unknown>,
            });
        });
    }

    /**
     * Settles every queued operation with a cancelled result rather than rejecting, so teardown
     * produces no unhandled rejections (§10).
     */
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

        // MERGE ORDER IS LOAD-BEARING (§10): the retained manifest is merged WITH the queued
        // intents before anything is applied, so a queued unload suppresses a re-upload.
        const work = this.#queue.merge(this.#hooks.retainedManifest());
        this.#queue.clear();

        const { reloaded, failed } = await this.#hooks.reupload(work);

        // The pairs are derived from our records, so this needs nothing from the caller (§6).
        this.#hooks.rebuildScene();

        // Queued operations run only after the manifest is back, so an op that references a
        // just-restored asset finds it.
        const pending = this.#pending.splice(0, this.#pending.length);
        for (const op of pending) op.resolve(await op.run());

        this.#state = 'ok';
        this.#hooks.onRestored(reloaded, failed);
    }
}
