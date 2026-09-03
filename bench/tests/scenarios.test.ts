// Every scenario, at its quick size. This is not a performance assertion — it is the check that the
// suite still runs at all, which is what rots when a pass is renamed or a world builder drifts.

import { describe, expect, it } from 'vitest';
import { Meter } from '../dist/meter.js';
import { SCENARIOS, selectScenarios } from '../dist/scenarios/index.js';
import { buildRun, runFileName } from '../dist/report.js';
import { buildWorld, overlappingPairs } from '../dist/worlds.js';

describe('world construction', () => {
    it('places a grid clear of itself, so a pair count is a choice and not an accident', () => {
        const rt = buildWorld({ entities: 200, colliders: true, spacing: 4 });
        expect(overlappingPairs(rt)).toBe(0);
    });

    it('reports overlap when the grid is tighter than the bodies on it', () => {
        const rt = buildWorld({ entities: 200, colliders: true, spacing: 0.5 });
        expect(overlappingPairs(rt)).toBeGreaterThan(0);
    });

    it('counts colliderless bodies stacked at one point as overlapping', () => {
        // Zero half-extents compare equal, so this is the world shape a benchmark must not build
        // by accident — the spacing dial exists because of it.
        const rt = buildWorld({ entities: 50, colliders: false, spacing: 0 });
        expect(overlappingPairs(rt)).toBeGreaterThan(0);
    });

    it('keeps a fixed grid width injective, which is what the churn scenarios spawn onto', () => {
        // A width derived from the count wraps later spawns back onto the base world; this is the
        // guard that caught it, and the reason `gridSide` is a dial rather than a derivation.
        const rt = buildWorld({ entities: 700, colliders: false, spacing: 4, gridSide: 512 });
        expect(overlappingPairs(rt)).toBe(0);
    });
});

describe('scenario selection', () => {
    it('matches on a name prefix', () => {
        expect(selectScenarios(['core']).length).toBeGreaterThan(1);
        expect(selectScenarios(['core.n-sweep']).map((s) => s.name)).toStrictEqual([
            'core.n-sweep',
        ]);
    });

    it('refuses a filter that names nothing, rather than running everything', () => {
        expect(() => selectScenarios(['nope'])).toThrow(/no scenario matches/);
    });

    it('runs everything when no filter is given', () => {
        expect(selectScenarios([])).toHaveLength(SCENARIOS.length);
    });
});

describe('every scenario', () => {
    // Serial and quick: these share one heap, and a parallel run would measure the others' garbage.
    for (const scenario of SCENARIOS) {
        it(`${scenario.name} produces finite measurements`, async () => {
            const meter = new Meter();
            try {
                const measurements = await scenario.run(meter, 'alloc', true);
                expect(measurements.length).toBeGreaterThan(0);
                for (const m of measurements) {
                    expect(m.id.startsWith(scenario.name)).toBe(true);
                    expect(Number.isFinite(m.nsPerTick ?? 0)).toBe(true);
                    expect(Number.isFinite(m.bytesPerTick ?? 0)).toBe(true);
                }
            } finally {
                meter.dispose();
            }
        });
    }
});

describe('run files', () => {
    it('names itself by instant, branch, tree and mode', () => {
        const run = buildRun({ mode: 'alloc', startedAt: new Date(0), measurements: [] });
        const name = runFileName(run);
        expect(name.startsWith('1970-01-01T00-00-00Z__')).toBe(true);
        expect(name.endsWith('__alloc.json')).toBe(true);
        // A branch name carries slashes and a filename cannot.
        expect(name.includes('/')).toBe(false);
    });

    it('stamps the commit and tree it measured', () => {
        const run = buildRun({ mode: 'gc', startedAt: new Date(), measurements: [] });
        expect(run.git.commit).not.toBe('');
        expect(run.git.shortCommit).toHaveLength(7);
        expect(typeof run.git.dirty).toBe('boolean');
        expect(run.host.execArgv).toContain('--expose-gc');
    });
});
