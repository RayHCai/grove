// Two ids for one class, or two classes under one id, is a load failure and not a last-write-wins:
// the id is what the wire carries, so either would attach the wrong script on the far end.

import { ClientScript, LoadError, ServerScript, SyncedScript } from '@platform/core';
import { describe, expect, it } from 'vitest';
import { ScriptRegistry, locationsFor } from '../src/registry.js';
import type { ScriptEntry } from '../src/registry.js';

class Rules extends ServerScript {}
class Clock extends ClientScript {}
class Runner extends SyncedScript {}

const entry = (id: string, ctor: typeof Rules, location: 'server' | 'client' | 'synced') =>
    ({ id, ctor, location }) as ScriptEntry;

describe('ScriptRegistry', () => {
    const registry = ScriptRegistry.from([
        entry('rules', Rules, 'server'),
        entry('runner', Runner, 'synced'),
    ]);

    it('resolves an id to its class and back', () => {
        expect(registry.resolve('rules')).toBe(Rules);
        expect(registry.idOf(Runner)).toBe('runner');
        expect(registry.resolve('absent')).toBeUndefined();
        expect(registry.idOf(Clock)).toBeUndefined();
    });

    it('carries the location the bundle resolved', () => {
        expect(registry.locationOf('runner')).toBe('synced');
        expect(registry.has('rules')).toBe(true);
        expect(registry.size).toBe(2);
        expect(registry.ids()).toEqual(['rules', 'runner']);
    });

    it('has no metadata for a class that declares no handler', () => {
        expect(registry.metadataOf('rules')).toBeUndefined();
    });

    it('refuses two classes under one id', () => {
        expect(() =>
            ScriptRegistry.from([entry('rules', Rules, 'server'), entry('rules', Clock, 'client')]),
        ).toThrow(LoadError);
    });

    it('refuses one class under two ids', () => {
        expect(() =>
            ScriptRegistry.from([entry('a', Rules, 'server'), entry('b', Rules, 'server')]),
        ).toThrow(LoadError);
    });
});

describe('locationsFor', () => {
    it('puts synced on both sides and each other location on one', () => {
        expect([...locationsFor('server')].toSorted()).toEqual(['server', 'synced']);
        expect([...locationsFor('client')].toSorted()).toEqual(['client', 'synced']);
    });
});
