// The @serverState immutability constraint is type-level (DESIGN §5.2): mutable
// declarations must fail to compile, readonly ones must not. This suite is a COMPILE-TIME
// check — the assertions live in the `Immutable<T>` conditional types below, and the file
// failing to typecheck IS the failure. The one runtime `expect` keeps vitest happy.

import { describe, it, expect } from 'vitest';
import type { Immutable, MutableStateRejected } from '../src/state/immutable.js';

// A helper: `Accepts<T>` is `true` only when `Immutable<T>` is T itself (not the branded
// rejection). `tsc` errors here if the predicate mis-classifies a type.
type Accepts<T> = Immutable<T> extends MutableStateRejected ? false : true;
type Rejects<T> = Immutable<T> extends MutableStateRejected ? true : false;

// Each binding is a compile-time assertion: if the predicate mis-classified its type, the
// annotation would not accept `true` and `tsc` would error here.
const probes = {
    // ✓ primitives and unions pass
    num: true satisfies Accepts<number>,
    str: true satisfies Accepts<string>,
    bool: true satisfies Accepts<boolean>,
    union: true satisfies Accepts<'lobby' | 'arena' | 'over'>,
    // ✓ readonly arrays and records pass, recursively
    roArray: true satisfies Accepts<readonly number[]>,
    roObject: true satisfies Accepts<{ readonly hp: number; readonly name: string }>,
    roDeep: true satisfies Accepts<readonly (readonly number[])[]>,
    // ✗ mutable array, object, record are rejected
    mutArray: true satisfies Rejects<number[]>,
    mutObject: true satisfies Rejects<{ hp: number }>,
    mutRecord: true satisfies Rejects<Record<string, number>>,
    // ✗ a mutable element inside a readonly array is still rejected (recurses)
    mutInReadonly: true satisfies Rejects<readonly { hp: number }[]>,
};

describe('@serverState immutability predicate (§5.2)', () => {
    it('classifies immutable and mutable declarations at compile time', () => {
        // The real assertions are the `satisfies` clauses above; if any mis-classified,
        // this file would not compile. This runtime check just anchors the suite.
        expect(Object.values(probes).every(Boolean)).toBe(true);
    });
});
