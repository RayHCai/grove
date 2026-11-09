// The one narrowing of a client frame, held to the caps both ends share.

import { describe, expect, it } from 'vitest';
import {
    MAX_ACTIONS_PER_FRAME,
    MAX_ACTION_NAME_LENGTH,
    MAX_IDENTITY_LENGTH,
    MAX_INTERACTIONS_PER_FRAME,
    MAX_REQUESTS_PER_FRAME,
    MAX_REQUEST_PAYLOAD_NODES,
    MAX_WIDGET_NAME_LENGTH,
    PROTOCOL_VERSION,
    asClientEnvelope,
    isActionName,
    isAdmissiblePayload,
    isRequestName,
    isWidgetName,
} from '../src/index.js';

const join = {
    kind: 'join-request',
    protocolVersion: PROTOCOL_VERSION,
    name: 'Ray',
    clientSentMs: 1,
    projectId: 'p',
    projectHash: 'h',
    bundleHash: '',
};

const presses = (n: number): unknown[] =>
    Array.from({ length: n }, (_, i) => ({ kind: 'press', widget: `w${i}` }));
const actions = (n: number): unknown[] =>
    Array.from({ length: n }, (_, i) => ({ action: `a${i}`, on: 'press' }));
const requests = (n: number): unknown[] => Array.from({ length: n }, (_, i) => ({ name: `r${i}` }));
const pressFrame = (event: object): unknown => ({ kind: 'interaction', tick: 1, events: [event] });
const inputFrame = (a: object): unknown => ({ kind: 'input', tick: 1, seq: 1, actions: [a] });

describe('asClientEnvelope', () => {
    it('admits one of each kind a client may send', () => {
        const frames = [
            join,
            { kind: 'input', tick: 3, seq: 0, actions: [{ action: 'jump', on: 'press' }] },
            { kind: 'interaction', tick: 3, events: [{ kind: 'click', netId: 4 }] },
            { kind: 'request', tick: 3, requests: [{ name: 'buy', data: { item: 'shield' } }] },
            { kind: 'time-sync', clientSentMs: 5 },
        ];
        for (const frame of frames) expect(asClientEnvelope(frame)).toBe(frame);
    });

    it('refuses a kind the server sends, and anything that is not an object', () => {
        expect(asClientEnvelope({ kind: 'welcome' })).toBeUndefined();
        expect(asClientEnvelope(null)).toBeUndefined();
        expect(asClientEnvelope('join-request')).toBeUndefined();
    });

    it('refuses each frame whole at one past its cap, and admits it at the cap', () => {
        const at = [
            { kind: 'input', tick: 1, seq: 1, actions: actions(MAX_ACTIONS_PER_FRAME) },
            { kind: 'interaction', tick: 1, events: presses(MAX_INTERACTIONS_PER_FRAME) },
            { kind: 'request', tick: 1, requests: requests(MAX_REQUESTS_PER_FRAME) },
        ];
        const past = [
            { kind: 'input', tick: 1, seq: 1, actions: actions(MAX_ACTIONS_PER_FRAME + 1) },
            { kind: 'interaction', tick: 1, events: presses(MAX_INTERACTIONS_PER_FRAME + 1) },
            { kind: 'request', tick: 1, requests: requests(MAX_REQUESTS_PER_FRAME + 1) },
        ];
        for (const frame of at) expect(asClientEnvelope(frame)).toBe(frame);
        for (const frame of past) expect(asClientEnvelope(frame)).toBeUndefined();
    });

    it('holds optional members to absent-not-undefined, which no codec could produce', () => {
        expect(asClientEnvelope(pressFrame({ kind: 'press', widget: 'go' }))).toBeDefined();
        expect(
            asClientEnvelope(pressFrame({ kind: 'press', widget: 'go', screen: 'menu' })),
        ).toBeDefined();
        expect(
            asClientEnvelope(pressFrame({ kind: 'press', widget: 'go', screen: undefined })),
        ).toBeUndefined();
        expect(asClientEnvelope(inputFrame({ action: 'x', on: 'hold', value: 0.5 }))).toBeDefined();
        expect(
            asClientEnvelope(inputFrame({ action: 'x', on: 'hold', value: Infinity })),
        ).toBeUndefined();
    });

    it('refuses an identity field too long to compare', () => {
        expect(
            asClientEnvelope({ ...join, projectId: 'p'.repeat(MAX_IDENTITY_LENGTH + 1) }),
        ).toBeUndefined();
    });
});

describe('the name predicates a sender checks before it frames anything', () => {
    it('agree with the caps they are named for, and refuse the empty name', () => {
        expect(isActionName('a'.repeat(MAX_ACTION_NAME_LENGTH))).toBe(true);
        expect(isActionName('a'.repeat(MAX_ACTION_NAME_LENGTH + 1))).toBe(false);
        expect(isWidgetName('w'.repeat(MAX_WIDGET_NAME_LENGTH))).toBe(true);
        expect(isWidgetName('w'.repeat(MAX_WIDGET_NAME_LENGTH + 1))).toBe(false);
        expect(isRequestName('')).toBe(false);
        expect(isActionName(7)).toBe(false);
    });
});

describe('isAdmissiblePayload', () => {
    it('refuses a reserved key, a non-finite number, and a graph past the node cap', () => {
        expect(isAdmissiblePayload({ item: 'shield', count: 2, nested: [1, { ok: true }] })).toBe(
            true,
        );
        expect(isAdmissiblePayload(JSON.parse('{"__proto__": {"polluted": true}}'))).toBe(false);
        expect(isAdmissiblePayload({ deep: { n: Number.POSITIVE_INFINITY } })).toBe(false);
        const wide: Record<string, number> = {};
        for (let i = 0; i < MAX_REQUEST_PAYLOAD_NODES; i++) wide[`k${i}`] = i;
        expect(isAdmissiblePayload(wide)).toBe(true);
        wide['one-more'] = 0;
        expect(isAdmissiblePayload(wide)).toBe(false);
    });
});
