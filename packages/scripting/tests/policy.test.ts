// The transcendentals exist in four places and only one of them is enforced at run time, so the
// other three are read off disk and compared here. A list that drifts is a SyncedScript that
// desyncs, and nothing else in the repo would notice.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';
import { DENIED_MATH, TRANSCENDENTALS } from '../src/policy.js';
import { REPO_ROOT } from './helpers.js';

describe('the transcendental list', () => {
    it('matches @platform/math, which implements them', () => {
        expect(reexportedFrom('packages/math/src/index.ts', './deterministic-math.js')).toEqual([
            ...TRANSCENDENTALS,
        ]);
    });

    it('matches @platform/engine, which is where a creator reaches them', () => {
        expect(reexportedFrom('packages/engine/src/index.ts', '@platform/math', 'sin')).toEqual([
            ...TRANSCENDENTALS,
        ]);
    });

    it('matches .oxlintrc.json, which refuses Math.* everywhere else in the repo', () => {
        expect(restrictedMathProperties()).toEqual([...TRANSCENDENTALS, 'random'].toSorted());
    });

    it('adds Math.random to the deny-list and nothing else', () => {
        expect([...DENIED_MATH.keys()].toSorted()).toEqual(
            [...TRANSCENDENTALS, 'random'].toSorted(),
        );
    });
});

/** The specifiers of the value re-export block naming `source` — the one carrying `contains`. */
function reexportedFrom(file: string, source: string, contains?: string): string[] {
    const text = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    const program = parseAst(text, { lang: 'ts' }, file) as unknown as {
        body: readonly Record<string, unknown>[];
    };
    for (const statement of program.body) {
        if (statement.type !== 'ExportNamedDeclaration') continue;
        if (statement.exportKind === 'type') continue;
        const from = statement.source as { value?: unknown } | null;
        if (!from || from.value !== source) continue;
        const names = (statement.specifiers as { local: { name: string } }[]).map(
            (specifier) => specifier.local.name,
        );
        if (contains === undefined || names.includes(contains)) return names;
    }
    throw new Error(`${file} re-exports nothing from ${source}`);
}

function restrictedMathProperties(): string[] {
    const config = JSON.parse(readFileSync(path.join(REPO_ROOT, '.oxlintrc.json'), 'utf8')) as {
        rules: { 'no-restricted-properties': [string, ...{ object: string; property: string }[]] };
    };
    const [, ...entries] = config.rules['no-restricted-properties'];
    return entries
        .filter((entry) => entry.object === 'Math')
        .map((entry) => entry.property)
        .toSorted();
}
