// The one implementation under every timed motion verb, so easing, cancellation,
// awaitability and last-one-wins are defined once. A cancelled tween leaves the property
// where it stopped, not at the target.

import type { Easing } from '@platform/math';
import { ease, lerp } from '@platform/math';
import { currentInvocation } from '../dispatch/ambient.js';
import type { GuardOwner, ScopeId } from '../dispatch/scope-tree.js';
import { NO_SCOPE } from '../dispatch/scope-tree.js';
import type { GuardedCall } from './timers.js';

/** How a tween reads and writes the value it animates. */
export interface TweenTarget {
    /** Identifies the target alone; the engine appends the prop for last-one-wins. */
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
    /** The script instance that started it — a `TweenTarget` may write a creator-authored setter. */
    owner: GuardOwner | null;
    cancelled: boolean;
}

export class TweenEngine {
    readonly #tweens = new Map<number, Tween>();
    readonly #byProp = new Map<string, number>();
    #nextId = 1;
    #simRate = 60;

    #guard: GuardedCall = (_owner, _method, fn) => {
        fn();
    };

    setSimRate(rate: number): void {
        this.#simRate = rate;
    }

    setGuard(guard: GuardedCall): void {
        this.#guard = guard;
    }

    /** Starts a tween, cancelling any other on the same (target, prop); a cancel resolves too. */
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

        // A non-finite duration makes every interpolated value NaN and the tween never reaches
        // t >= 1, so it holds its (target, prop) slot for the rest of the session.
        if (!Number.isFinite(seconds)) {
            throw new RangeError(
                `tween duration must be a finite number of seconds, got ${seconds}`,
            );
        }
        const id = this.#nextId++;
        const durationTicks = Math.max(1, Math.round(seconds * this.#simRate));
        return new Promise<void>((resolve) => {
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
                owner: currentInvocation()?.owner ?? null,
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
        // NO_SCOPE is every hostless tween at once, never one host's, so no teardown may claim it.
        if (hostScopeId === NO_SCOPE) return;
        const doomed: number[] = [];
        for (const [id, tween] of this.#tweens) {
            if (tween.hostScopeId === hostScopeId) doomed.push(id);
        }
        for (const id of doomed) this.cancel(id);
    }

    /** Advances every tween a tick, in ascending id order because determinism needs one. */
    advance(): void {
        const ids = [...this.#tweens.keys()].toSorted((a, b) => a - b);
        for (const id of ids) {
            const tween = this.#tweens.get(id);
            if (!tween || tween.cancelled) continue;

            tween.elapsed += 1;
            const t = Math.min(1, tween.elapsed / tween.durationTicks);
            const eased = ease(t, tween.easing);
            // `set` is engine code for an Entity and a creator-authored setter for a plain object,
            // and the object form is what `tween(this, …)` on a script reaches.
            this.#guard(tween.owner, `tween:${id}`, () => {
                tween.target.set(tween.prop, lerp(tween.from, tween.to, eased));
            });

            if (t >= 1) {
                this.#tweens.delete(id);
                const propKey = `${tween.target.key}:${tween.prop}`;
                if (this.#byProp.get(propKey) === id) this.#byProp.delete(propKey);
                tween.resolve?.();
            }
        }
    }

    clear(): void {
        this.#tweens.clear();
        this.#byProp.clear();
    }
}
