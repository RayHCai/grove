// Captured whole rather than filtered: draws from different entities interleave into one
// stream, so no subsequence belongs to a scope.

import { SeededRandom } from '@platform/math';
import { DEFAULT_PRNG_SEED } from '../config.js';
import type { Scope, ScopeMode, SnapshotStore } from '../loop/store-registry.js';

export type PRNGBuffer = [number, number, number, number];

export class PRNGStore implements SnapshotStore<PRNGBuffer> {
    readonly storeName = 'prng';
    readonly scopeMode: ScopeMode = 'whole';

    readonly stream = new SeededRandom(DEFAULT_PRNG_SEED);

    /** Restarts the stream, which is what two peers must agree on to draw the same numbers. */
    seed(seed: number): void {
        this.stream.seed(seed);
    }

    createBuffer(): PRNGBuffer {
        return [0, 0, 0, 0];
    }

    capture(into: PRNGBuffer, _scope: Scope): void {
        const state = this.stream.capture();
        into[0] = state[0];
        into[1] = state[1];
        into[2] = state[2];
        into[3] = state[3];
    }

    apply(from: PRNGBuffer): void {
        this.stream.restore([from[0], from[1], from[2], from[3]]);
    }
}
