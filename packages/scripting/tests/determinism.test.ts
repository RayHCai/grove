// The rule is scoped, and the scope is the whole difference: the same `Date.now()` is a refusal in
// a SyncedScript and correct in a ClientScript. Both directions are asserted, because a pass that
// only ever says no is indistinguishable from one that always says no.

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeScripts } from '../src/toolchain/analyze.js';
import { assertDeterminism, checkDeterminism } from '../src/toolchain/check.js';
import { DeterminismError } from '../src/errors.js';
import { FIXTURES } from './helpers.js';

const clean = analyzeScripts({ srcDir: path.join(FIXTURES, 'project', 'src') }).synced;
const dirty = analyzeScripts({ srcDir: path.join(FIXTURES, 'nondeterministic', 'src') }).synced;
const refused = (file: string): string[] =>
    checkDeterminism(dirty)
        .filter((d) => d.file === file)
        .map((d) => d.found);

describe('checkDeterminism', () => {
    it('refuses an approximated transcendental and a clock', () => {
        expect(refused('synced/drifter.ts')).toEqual(['Math.sin', 'Date.now']);
    });

    it('refuses the three ways round the member check', () => {
        expect(refused('synced/evader.ts')).toEqual(['Math', 'Math[…]', 'globalThis']);
    });

    it('names the file, the class and the redirect target', () => {
        const [first] = checkDeterminism(dirty);
        expect(first?.file).toBe('synced/drifter.ts');
        expect(first?.line).toBe(10);
        expect(first?.klass).toBe('Drifter');
        expect(first?.use).toContain('@platform/engine');
    });

    it('leaves Date.now alone in a ClientScript, and Math.floor alone anywhere', () => {
        expect(checkDeterminism(clean)).toEqual([]);
    });

    it('fails the build rather than warning', () => {
        expect(() => assertDeterminism(dirty)).toThrow(DeterminismError);
        try {
            assertDeterminism(dirty);
            expect.unreachable();
        } catch (err) {
            const error = err as DeterminismError;
            expect(error.diagnostics).toHaveLength(5);
            expect(error.message).toContain('synced/drifter.ts:10');
            expect(error.message).toContain('Drifter');
            expect(error.message).toContain('@platform/engine');
        }
    });

    it('passes a project whose synced half reaches only exact members', () => {
        expect(() => assertDeterminism(clean)).not.toThrow();
    });
});
