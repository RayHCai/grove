// `docs/api_spec.ts` is the authoritative creator surface, and this package's barrel is the path
// that surface actually resolves through. That claim is written down in two places and was checked
// in neither: the spec is a `declare module` block nothing imports, and the barrel is a file nobody
// diffs against it. This test is the diff.
//
// It reads the spec as TEXT rather than importing it, because the block declares a module that does
// not exist at runtime — `declare module '@platform/engine'` names this package, and importing the
// file to check it would be the package checking its own re-export of itself.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as engine from '../src/index.js';

// Every type the spec declares, imported so `tsc` fails here if one stops being exported. The
// runtime check below cannot see these: a type has no value to enumerate.
import type {
    ActionState,
    Animation,
    AssetKind,
    AssetRef,
    Bounds,
    Collider,
    Concurrency,
    Ctx,
    Cursor,
    Easing,
    EventPhase,
    FindQuery,
    HUDAnchor,
    HandlerDecorator,
    HandlerOptions,
    Host,
    InputBindings,
    Movement,
    Random,
    ScriptQuery,
    SoundHandle,
    SoundOptions,
    StateDecorator,
    Vec3,
} from '../src/index.js';

const SPEC = fileURLToPath(new URL('../../../docs/api_spec.ts', import.meta.url));

/** The body of `declare module '@platform/engine' { … }`, brace-matched. */
function engineBlock(source: string): string {
    const start = source.indexOf("declare module '@platform/engine' {");
    if (start < 0) throw new Error('api_spec.ts declares no @platform/engine module');
    let depth = 0;
    for (let i = source.indexOf('{', start); i < source.length; i++) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(start, i);
        }
    }
    throw new Error('api_spec.ts has an unterminated @platform/engine block');
}

/**
 * Names the spec declares as VALUES, at the block's own indent level only.
 *
 * One indent depth rather than any: an interface's members are indented further, and a `function`
 * inside one is a method signature rather than a module export.
 */
function specValues(block: string): string[] {
    const names = new Set<string>();
    for (const line of block.split('\n')) {
        const match =
            /^ {4}(?:export )?(?:function|const|(?:abstract )?class) (\w+)/.exec(line) ?? null;
        if (match?.[1] !== undefined) names.add(match[1]);
    }
    return [...names].toSorted();
}

/** The barrel's runtime exports, as a plain record so a name can be looked up by string. */
const barrel: Readonly<Record<string, unknown>> = { ...engine };

const block = engineBlock(readFileSync(SPEC, 'utf8'));

describe('the barrel matches docs/api_spec.ts', () => {
    it('exports every value the spec declares, and nothing the spec does not', () => {
        // Equality in both directions on purpose. A missing export is a creator writing against a
        // documented name that does not resolve; an extra one is a name that reached the surface
        // without ever being specified, which is how a surface stops being reviewable.
        expect(Object.keys(barrel).toSorted()).toStrictEqual(specValues(block));
    });

    it('finds a surface worth checking, so a broken extractor cannot pass silently', () => {
        // Without this, a regex that matched nothing would compare [] to [] and report agreement.
        expect(specValues(block).length).toBeGreaterThan(50);
        expect(specValues(block)).toContain('game');
        expect(specValues(block)).toContain('onStart');
        expect(specValues(block)).toContain('sin');
    });

    it('every declared value is actually there, not a stale name', () => {
        for (const name of specValues(block)) {
            expect(barrel[name]).toBeDefined();
        }
    });
});

describe('the spec types resolve through the barrel', () => {
    it('compiles, which is the assertion', () => {
        // The imports above are the test; `tsc -p tsconfig.test.json` failing IS the failure. This
        // block keeps vitest honest and stops the import list being elided as unused.
        const named: Record<string, true> = {
            ActionState: true,
            Animation: true,
            AssetKind: true,
            AssetRef: true,
            Bounds: true,
            Collider: true,
            Concurrency: true,
            Ctx: true,
            Cursor: true,
            Easing: true,
            EventPhase: true,
            FindQuery: true,
            HUDAnchor: true,
            HandlerDecorator: true,
            HandlerOptions: true,
            Host: true,
            InputBindings: true,
            Movement: true,
            Random: true,
            ScriptQuery: true,
            SoundHandle: true,
            SoundOptions: true,
            StateDecorator: true,
            Vec3: true,
        };
        type Probe = [
            ActionState,
            Animation,
            AssetKind,
            AssetRef,
            Bounds,
            Collider,
            Concurrency,
            Ctx,
            Cursor,
            Easing,
            EventPhase,
            FindQuery,
            HUDAnchor,
            HandlerDecorator,
            HandlerOptions,
            Host,
            InputBindings,
            Movement,
            Random,
            ScriptQuery<object>,
            SoundHandle,
            SoundOptions,
            StateDecorator,
            Vec3,
        ];
        const probeLength: Probe['length'] = 24;

        // The spec's own type declarations, counted the same way the values are.
        const declared = new Set<string>();
        for (const line of block.split('\n')) {
            const match = /^ {4}(?:export )?(?:interface|type) (\w+)/.exec(line) ?? null;
            if (match?.[1] !== undefined) declared.add(match[1]);
        }
        expect([...declared].toSorted()).toStrictEqual(Object.keys(named).toSorted());
        expect(probeLength).toBe(24);
    });
});
