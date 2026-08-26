// Each seam is an interface with a null implementation, so every live member is exercisable in
// Node with no browser and no network. The real owner swaps its implementation in.

import type { EntityId } from '../ids.js';
import type { AssetRef } from './assets.js';
import type { Countdown } from './wrappers.js';

/** The frame clock. Core is pumped, never self-driving. */
export interface Clock {
    now(): number;
}

/** Manual, test-driven clock: the host's accumulator reads it, tests set it. */
export class ManualClock implements Clock {
    #t = 0;
    now(): number {
        return this.#t;
    }
    set(seconds: number): void {
        this.#t = seconds;
    }
    tick(seconds: number): void {
        this.#t += seconds;
    }
}

/** The collision integrator. */
export interface PhysicsSink {
    /** Sweeps `id` along `velocity` over `dt`, writes the position, reports which sides stopped it. */
    move(
        id: EntityId,
        dt: number,
        velocity: Readonly<{ x: number; y: number; z: number }>,
    ): Blocked;
}

export interface Blocked {
    up: boolean;
    down: boolean;
    left: boolean;
    right: boolean;
    forward: boolean;
    back: boolean;
}

export function noBlocked(): Blocked {
    return { up: false, down: false, left: false, right: false, forward: false, back: false };
}

/** Key-value store. Real owner: the host app. */
export interface KVStore {
    get(scope: string, key: string): Promise<unknown>;
    set(scope: string, key: string, value: unknown): Promise<void>;
    delete(scope: string, key: string): Promise<void>;
}

export class MemoryKVStore implements KVStore {
    readonly #data = new Map<string, unknown>();

    // Length-prefixed so neither half can forge the other, and the NUL spelled out because a
    // literal control byte is invisible to review and survives no reformat.
    #k(scope: string, key: string): string {
        return `${scope.length}\u0000${scope}${key}`;
    }

    get(scope: string, key: string): Promise<unknown> {
        return Promise.resolve(this.#data.get(this.#k(scope, key)));
    }

    set(scope: string, key: string, value: unknown): Promise<void> {
        this.#data.set(this.#k(scope, key), value);
        return Promise.resolve();
    }

    delete(scope: string, key: string): Promise<void> {
        this.#data.delete(this.#k(scope, key));
        return Promise.resolve();
    }
}

/** Real owners: the audio layer and the client. */
export interface EffectSink {
    play(name: string, opts?: unknown): void;
}

export class NullEffectSink implements EffectSink {
    play(): void {}
}

/**
 * What one panel-authored widget currently shows.
 *
 * The `Countdown` travels rather than a sampled number of seconds: a bound timer counts down every
 * tick with no further call from creator code, so a snapshot would freeze at whatever the last verb
 * left it at. The presenter reads `remaining` when it draws.
 */
export interface HUDWidgetState {
    text?: string;
    number?: number;
    /** 0..1 fill for a bar. */
    fraction?: number;
    icon?: AssetRef;
    countdown?: Countdown;
    visible: boolean;
    enabled: boolean;
}

/**
 * One player's interface, as the presentation layer sees it. Real owner: the client.
 *
 * Push, not pull: core holds the authored state and hands over whatever changed, so the presenter
 * never has to walk the whole HUD to find the one widget a handler wrote.
 */
export interface HUDSink {
    /** A widget changed; the whole record is handed over rather than a patch. */
    widget(name: string, state: Readonly<HUDWidgetState>): void;
    /** A screen opened or closed. */
    screen(name: string, visible: boolean): void;
}

export class NullHUDSink implements HUDSink {
    widget(): void {}
    screen(): void {}
}
