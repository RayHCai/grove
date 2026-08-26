// Locations come out of the source, not out of `__location`: deciding which chunk a class belongs
// in by evaluating the creator's module is what this pass exists to avoid. The chain therefore has
// to be walked across files, and an abstract link in it must not be stamped with an id.

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeScripts } from '../src/toolchain/analyze.js';
import { FIXTURES } from './helpers.js';

const analysis = analyzeScripts({ srcDir: path.join(FIXTURES, 'project', 'src') });
const byLocal = new Map(analysis.scripts.map((script) => [script.local, script]));

describe('analyzeScripts', () => {
    it('locates one class per base, and resolves through an intermediate class', () => {
        expect([...byLocal.keys()].toSorted()).toEqual(['Clock', 'Router', 'Rules', 'Runner']);
        expect(byLocal.get('Rules')?.location).toBe('server');
        expect(byLocal.get('Clock')?.location).toBe('client');
        // Runner extends Movable extends SyncedScript, in two different files.
        expect(byLocal.get('Runner')?.location).toBe('synced');
    });

    it('leaves the abstract link out — it is not a class an attach site can take', () => {
        expect(byLocal.has('Movable')).toBe(false);
        expect(analysis.modules.some((mod) => mod.classes.some((k) => k.local === 'Movable'))).toBe(
            true,
        );
    });

    it('carries the export name a default export is reached by', () => {
        expect(byLocal.get('Router')?.exported).toBe('default');
    });

    it('names each module the way the lowered output does', () => {
        expect(byLocal.get('Runner')?.module).toBe('synced/runner');
        expect(byLocal.get('Runner')?.file).toBe('synced/runner.ts');
        expect(byLocal.get('Runner')?.exported).toBe('Runner');
    });

    it('ignores a module that declares no script', () => {
        const shared = analysis.modules.find((mod) => mod.file === 'shared.ts');
        expect(shared?.classes).toEqual([]);
    });
});
