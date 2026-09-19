// Each entry loads its own module when it runs: a static table would drag the authority, the codec
// and the renderer into a process that only measures a bare loop.

import { budgetFor } from '../meter.js';
import type { Meter, Mode } from '../meter.js';
import type { Measurement } from '../report.js';

export interface Scenario {
    name: string;
    /** What it answers, printed by `--list`. */
    about: string;
    /**
     * The modes this scenario has an answer for, declared rather than assumed: one whose result
     * is a difference between timings would file an allocation number in a GC run.
     */
    modes: readonly Mode[];
    run: (meter: Meter, mode: Mode, quick: boolean) => Promise<Measurement[]>;
}

const BOTH: readonly Mode[] = ['alloc', 'gc'];
const ALLOC_ONLY: readonly Mode[] = ['alloc'];

/** The reduced inputs a smoke run uses: same code paths, a fraction of the wall time. */
const QUICK_N = [100, 300] as const;
const QUICK_SCRIPTS = [0, 50] as const;

export const SCENARIOS: readonly Scenario[] = [
    {
        name: 'core.n-sweep',
        about: 'tick cost and bytes against entity count, with and without colliders',
        modes: BOTH,
        run: async (meter, mode, quick) => {
            const { N_SWEEP, nSweep } = await import('./core.js');
            return nSweep(meter, mode, budgetFor(quick), quick ? QUICK_N : N_SWEEP);
        },
    },
    {
        name: 'core.script-sweep',
        about: 'the marginal cost of one more attached script, contacts held out',
        modes: BOTH,
        run: async (meter, mode, quick) => {
            const { SCRIPT_SWEEP, scriptSweep } = await import('./core.js');
            return scriptSweep(meter, mode, budgetFor(quick), quick ? QUICK_SCRIPTS : SCRIPT_SWEEP);
        },
    },
    {
        name: 'core.pass-breakdown',
        about: 'each tick pass priced by removing it from a live world',
        modes: ALLOC_ONLY,
        run: async (meter, _mode, quick) => {
            const { passBreakdown } = await import('./core.js');
            return [await passBreakdown(meter, budgetFor(quick), quick ? 200 : 1000)];
        },
    },
    {
        name: 'core.role-split',
        about: 'what isServer costs, with the contact walk stubbed out so it is visible',
        modes: ALLOC_ONLY,
        run: async (meter, _mode, quick) => {
            const { roleSplit } = await import('./core.js');
            return roleSplit(meter, budgetFor(quick), quick ? 200 : 1000);
        },
    },
    {
        name: 'churn',
        about: 'a world that recycles slots, and one whose entity count keeps rising',
        modes: ALLOC_ONLY,
        run: async (meter, _mode, quick) => {
            const { churnScenarios } = await import('./churn.js');
            return churnScenarios(meter, budgetFor(quick), quick ? 1 : 4);
        },
    },
    {
        name: 'stack',
        about: 'the composed application: authority, codec, transport, and N predicting clients',
        modes: BOTH,
        run: async (meter, mode, quick) => {
            const { stackScenarios, tabCounts } = await import('./stack.js');
            return stackScenarios(meter, mode, budgetFor(quick), quick ? [1] : tabCounts());
        },
    },
];

export function selectScenarios(only: readonly string[]): readonly Scenario[] {
    if (only.length === 0) return SCENARIOS;
    const chosen = SCENARIOS.filter((s) => only.some((prefix) => s.name.startsWith(prefix)));
    if (chosen.length === 0) {
        throw new Error(
            `no scenario matches ${only.join(', ')} — known: ${SCENARIOS.map((s) => s.name).join(', ')}`,
        );
    }
    return chosen;
}
