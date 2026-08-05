// The tween engine (DESIGN §6, §9.1): the shared implementation under every timed motion
// verb, so cancellation, easing, awaitability and last-one-wins conflict resolution are
// defined once. Ticks from the loop at step 7. A cancelled tween leaves the property at
// its current value, not the target (§9.1).

import type { Easing } from '@platform/math';
import { ease, lerp } from '@platform/math';
import type { ScopeId } from '../dispatch/scope-tree.js';

/** How a tween reads and writes the value it animates. */
export interface TweenTarget {
    /** Stable key for last-one-wins conflict resolution: `${entityId}:${prop}`. */
    readonly key: string;
    get(prop: string): number;
    set(prop: string, value: number): void;
}

interface Tween {
    id: number;
    hostScopeId: ScopeId;
    target: TweenTarget;
    prop: string;
    from: number;
    to: number;
    elapsed: number;
    durationTicks: number;
    easing: Easing;
    resolve: (() => void) | null;
    cancelled: boolean;
}

export class TweenEngine {
    readonly #tweens = new Map<number, Tween>();
    /** `${target.key}:${prop}` → active tween id, for last-one-wins. */
    readonly #byProp = new Map<string, number>();
    #nextId = 1;
    #simRate = 60;

    setSimRate(rate: number): void {
        this.#simRate = rate;
    }

    /**
     * Starts a tween on one property. A second tween on the same (target, prop) cancels
     * the first — last one wins (§9.1). Resolves on completion; a cancelled tween's
     * promise resolves silently, leaving the property where it stopped.
     */
    start(
        target: TweenTarget,
        prop: string,
        to: number,
        seconds: number,
        hostScopeId: ScopeId,
        easing: Easing = 'linear',
    ): Promise<void> {
        const propKey = `${target.key}:${prop}`;
        const existing = this.#byProp.get(propKey);
        if (existing !== undefined) this.cancel(existing);

        const id = this.#nextId++;
        const durationTicks = Math.max(1, Math.round(seconds * this.#simRate));
        return new Promise<void>(resolve => {
            const tween: Tween = {
                id,
                hostScopeId,
                target,
                prop,
                from: target.get(prop),
                to,
                elapsed: 0,
                durationTicks,
                easing,
                resolve,
                cancelled: false,
            };
            this.#tweens.set(id, tween);
            this.#byProp.set(propKey, id);
        });
    }

    cancel(id: number): void {
        const tween = this.#tweens.get(id);
        if (!tween) return;
        tween.cancelled = true;
        this.#tweens.delete(id);
        const propKey = `${tween.target.key}:${tween.prop}`;
        if (this.#byProp.get(propKey) === id) this.#byProp.delete(propKey);
        tween.resolve?.();
    }

    cancelScope(hostScopeId: ScopeId): void {
        const doomed: number[] = [];
        for (const [id, tween] of this.#tweens) {
            if (tween.hostScopeId === hostScopeId) doomed.push(id);
        }
        for (const id of doomed) this.cancel(id);
    }

    /** Advances every tween one tick, writing interpolated values. Order is by tween id. */
    advance(): void {
        const ids = [...this.#tweens.keys()].toSorted((a, b) => a - b);
        for (const id of ids) {
            const tween = this.#tweens.get(id);
            if (!tween || tween.cancelled) continue;

            tween.elapsed += 1;
            const t = Math.min(1, tween.elapsed / tween.durationTicks);
            const eased = ease(t, tween.easing);
            tween.target.set(tween.prop, lerp(tween.from, tween.to, eased));

            if (t >= 1) {
                this.#tweens.delete(id);
                const propKey = `${tween.target.key}:${tween.prop}`;
                if (this.#byProp.get(propKey) === id) this.#byProp.delete(propKey);
                tween.resolve?.();
            }
        }
    }

    get activeCount(): number {
        return this.#tweens.size;
    }

    clear(): void {
        this.#tweens.clear();
        this.#byProp.clear();
    }
}
