// The shim guards a realm, so it is asserted against one — a plain object standing in for the
// global of the context a chunk is evaluated in. Guarding the host's own realm would break the
// ClientScript half of the same chunk, which is why the static pass is the mechanism.

import { describe, expect, it } from 'vitest';
import { DeterminismError } from '../src/errors.js';
import { installDeterminismShim } from '../src/shim.js';

interface Realm {
    Date: DateConstructor;
    Math: typeof Math;
    globalThis: unknown;
    performance: unknown;
}

describe('installDeterminismShim', () => {
    it('throws on a denied global, naming what to use instead', () => {
        const realm = {} as Realm;
        const shim = installDeterminismShim({ target: realm });
        expect(() => realm.Date).toThrow(DeterminismError);
        expect(() => realm.Date).toThrow(/@platform\/engine/);
        expect(() => realm.performance).toThrow(DeterminismError);
        shim.dispose();
    });

    it('throws on an approximated Math member and answers on an exact one', () => {
        const realm = {} as Realm;
        const shim = installDeterminismShim({ target: realm });
        expect(() => realm.Math.sin(1)).toThrow(DeterminismError);
        expect(() => realm.Math.random()).toThrow(DeterminismError);
        expect(realm.Math.floor(1.9)).toBe(1);
        expect(realm.Math.max(1, 2)).toBe(2);
        expect(realm.Math.PI).toBe(Math.PI);
        shim.dispose();
    });

    it('leaves an allowed name alone', () => {
        const realm = { Date: Date } as Realm;
        const shim = installDeterminismShim({ target: realm, allow: ['Date'] });
        expect(realm.Date).toBe(Date);
        expect(shim.guarded).not.toContain('Date');
        expect(shim.guarded).toContain('performance');
        shim.dispose();
    });

    it('puts every original back, including the ones that were never there', () => {
        const original = Date;
        const realm = { Date: original } as Realm;
        const shim = installDeterminismShim({ target: realm });
        expect(Object.hasOwn(realm, 'Math')).toBe(true);
        shim.dispose();
        expect(realm.Date).toBe(original);
        expect(Object.hasOwn(realm, 'Math')).toBe(false);
        expect(Object.hasOwn(realm, 'globalThis')).toBe(false);
    });
});
