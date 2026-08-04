// The seeded PRNG as a snapshot store (DESIGN §8.1). Its stream is stateful — every draw
// advances it — so a replay resuming from the wrong position draws different numbers,
// precisely the failure seeded randomness exists to prevent (§1.2). It is captured
// WHOLE: draws from different entities interleave into one sequence, so no subsequence
// belongs to a scope.

import { SeededRandom } from '@platform/math';
import type { Scope, ScopeMode, SnapshotStore } from '../loop/store-registry.js';

export type PRNGBuffer = [number, number, number, number];

export class PRNGStore implements SnapshotStore<PRNGBuffer> {
    readonly storeName = 'prng';
    readonly scopeMode: ScopeMode = 'whole';

    readonly stream = new SeededRandom(1);

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
