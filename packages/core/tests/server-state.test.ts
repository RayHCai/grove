// The @serverState accessor-pair mechanism — the highest-risk claim in the
// design. Fixtures are compiled by the build (see src/testkit/fixtures.ts); this file
// carries no decorator syntax, so the oxc test transform handles it.

import { describe, it, expect } from 'vitest';
import { Wallet } from '../dist/testkit/fixtures.js';
import {
    STATE_TARGET,
    authoredValue,
    hasNoDataProperty,
    redirectState,
} from '../src/state/backing.js';

describe('@serverState accessor pair', () => {
    it('leaves no data property for a decorated field', () => {
        const w = new Wallet();
        expect(hasNoDataProperty(w, 'credits')).toBe(true);
        const desc = Object.getOwnPropertyDescriptor(w, 'credits');
        expect(desc?.get).toBeTypeOf('function');
        expect(desc?.set).toBeTypeOf('function');
    });

    it('reads the authored value initially', () => {
        const w = new Wallet();
        expect(w.credits).toBe(10);
        expect(w.label).toBe('anon');
    });

    it('captures the authored value for the wiring seed', () => {
        const w = new Wallet();
        expect(authoredValue(w, 'credits')).toBe(10);
    });

    it('routes assignment and compound assignment through the setter', () => {
        const w = new Wallet();
        w.credits = 2;
        expect(w.credits).toBe(2);
        w.credits += 1;
        expect(w.credits).toBe(3);
    });

    it('keeps a plain field a plain own data property', () => {
        const w = new Wallet();
        const desc = Object.getOwnPropertyDescriptor(w, 'plain');
        expect(desc?.value).toBe(5);
        expect(desc?.get).toBeUndefined();
    });

    it('gives each instance its own value, not a shared prototype slot', () => {
        const a = new Wallet();
        const b = new Wallet();
        a.credits = 99;
        expect(b.credits).toBe(10);
    });

    it('redirects onto a host record and marks on write', () => {
        const w = new Wallet();
        const record = new Map<string, unknown>();
        record.set('credits', 500); // a restored value seeded on the record
        const marked: string[] = [];
        redirectState(w as object, record, (field) => marked.push(field));

        expect(w.credits).toBe(500);
        expect((w as unknown as Record<symbol, unknown>)[STATE_TARGET]).toBe(record);

        w.credits = 501;
        expect(record.get('credits')).toBe(501);
        expect(marked).toEqual(['credits']);
    });
});
