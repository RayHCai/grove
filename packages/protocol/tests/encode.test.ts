import { describe, expect, it } from 'vitest';
import type { JsonValue, Message } from '@platform/transport';
import { jsonCodec } from '@platform/transport';
import { MAX_VALUE_DEPTH, toWireValue } from '../src/index.js';

function nest(depth: number): object {
    let value: object = { leaf: 1 };
    for (let i = 0; i < depth; i++) value = { n: value };
    return value;
}

class Thing {
    constructor(readonly id: number) {}
}

const thingRef = (value: object): JsonValue | undefined =>
    value instanceof Thing ? value.id : undefined;

describe('toWireValue', () => {
    it('passes plain JSON through as itself', () => {
        const value = { a: [1, 'two', true, null], b: { c: -3.5 } };
        expect(toWireValue(value)).toStrictEqual(value);
    });

    it('drops every value the wire would deliver as something other than itself', () => {
        for (const bad of [
            Number.NaN,
            Number.POSITIVE_INFINITY,
            undefined,
            () => 1,
            Symbol('s'),
            10n,
            new Map(),
            new Date(0),
            { nested: [Number.NaN] },
            JSON.parse('{"__proto__": 1}') as object,
            { deep: { constructor: 1 } },
        ]) {
            expect(toWireValue(bad)).toBeUndefined();
        }
    });

    it('never runs a getter, which would be creator code outside any boundary', () => {
        let ran = false;
        const value = {
            get x(): number {
                ran = true;
                return 1;
            },
        };
        expect(toWireValue(value)).toBeUndefined();
        expect(ran).toBe(false);
    });

    it('refuses a cycle and keeps a shared child, as the wire would copy it', () => {
        const cyclic: { self?: unknown } = {};
        cyclic.self = cyclic;
        expect(toWireValue(cyclic)).toBeUndefined();

        const shared = { n: 1 };
        expect(toWireValue({ a: shared, b: shared })).toStrictEqual({ a: { n: 1 }, b: { n: 1 } });
    });

    it('stops at one depth, below what the codec will carry inside an envelope', () => {
        expect(toWireValue(nest(MAX_VALUE_DEPTH))).toBeUndefined();
        const deepest = toWireValue(nest(MAX_VALUE_DEPTH - 1));
        expect(deepest).toBeDefined();
        const envelope = {
            kind: 'state',
            state: [{ host: { kind: 'game' }, fields: { deepest } }],
        };
        expect(() => jsonCodec.encode(envelope as unknown as Message)).not.toThrow();
    });

    it('substitutes what the ref names, at any depth, and drops a class it does not name', () => {
        expect(toWireValue({ who: [new Thing(7)] }, thingRef)).toStrictEqual({ who: [7] });
        expect(toWireValue({ who: new Thing(7) })).toBeUndefined();
        expect(toWireValue(new Map(), thingRef)).toBeUndefined();
    });
});
