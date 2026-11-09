// The authority's narrowing of a client frame, here so the client sizes and names what it sends by
// the same rules the authority refuses a whole frame by.

import { RESERVED_KEYS } from '@platform/transport';
import type {
    ClientToServer,
    GameRequest,
    InputAction,
    InputFrame,
    Interaction,
    InteractionFrame,
    JoinRequest,
    RequestFrame,
    TimeSync,
} from './envelopes.js';
import {
    MAX_ACTIONS_PER_FRAME,
    MAX_ACTION_NAME_LENGTH,
    MAX_IDENTITY_LENGTH,
    MAX_INTERACTIONS_PER_FRAME,
    MAX_REQUESTS_PER_FRAME,
    MAX_REQUEST_NAME_LENGTH,
    MAX_REQUEST_PAYLOAD_NODES,
    MAX_WIDGET_NAME_LENGTH,
} from './limits.js';

/** Whether an inbound frame names a message a client may send. */
export function asClientEnvelope(message: unknown): ClientToServer | undefined {
    if (typeof message !== 'object' || message === null) return undefined;
    const kind = (message as { kind?: unknown }).kind;
    switch (kind) {
        case 'join-request':
            return isJoinRequest(message) ? message : undefined;
        case 'input':
            return isInputFrame(message) ? message : undefined;
        case 'interaction':
            return isInteractionFrame(message) ? message : undefined;
        case 'request':
            return isRequestFrame(message) ? message : undefined;
        case 'time-sync':
            return isTimeSync(message) ? message : undefined;
        default:
            return undefined;
    }
}

/** A name an input action may carry. */
export function isActionName(value: unknown): value is string {
    return typeof value === 'string' && value !== '' && value.length <= MAX_ACTION_NAME_LENGTH;
}

/** A name a widget or a screen may carry. */
export function isWidgetName(value: unknown): value is string {
    return typeof value === 'string' && value !== '' && value.length <= MAX_WIDGET_NAME_LENGTH;
}

/** A name a request may carry. */
export function isRequestName(value: unknown): value is string {
    return typeof value === 'string' && value !== '' && value.length <= MAX_REQUEST_NAME_LENGTH;
}

/** The codec's decode rules (node cap, no reserved key, finite numbers), since a handler gets it whole. */
export function isAdmissiblePayload(payload: Record<string, unknown>): boolean {
    const stack: unknown[] = [payload];
    let nodes = 0;
    while (stack.length > 0) {
        const node = stack.pop();
        if (node === null || typeof node !== 'object') continue;
        const isArray = Array.isArray(node);
        // `Object.keys` rather than `Object.values`, because `JSON.parse` made `__proto__` an own
        // data property and it is the key that is the attack.
        for (const key of Object.keys(node)) {
            if (!isArray && RESERVED_KEYS.has(key)) return false;
            if (++nodes > MAX_REQUEST_PAYLOAD_NODES) return false;
            const child = (node as Record<string, unknown>)[key];
            // `1e999` is well-formed JSON that parses to Infinity, which no encoder on this wire
            // would ever have produced.
            if (typeof child === 'number' && !Number.isFinite(child)) return false;
            stack.push(child);
        }
    }
    return true;
}

/** Absent, tested with `in`, or passing `check`: an explicit `undefined` is a frame no codec produces. */
function absentOr(
    record: Record<string, unknown>,
    key: string,
    check: (value: unknown) => boolean,
): boolean {
    return !(key in record) || check(record[key]);
}

/** Every field, checked, not `Partial<JoinRequest>`, which claims the narrowing without it. */
function isJoinRequest(message: object): message is JoinRequest {
    const m = message as Record<string, unknown>;
    return (
        typeof m['protocolVersion'] === 'number' &&
        typeof m['name'] === 'string' &&
        Number.isFinite(m['clientSentMs']) &&
        isIdentityString(m['projectId']) &&
        isIdentityString(m['projectHash']) &&
        isIdentityString(m['bundleHash'])
    );
}

/** An identity field: a string short enough to compare. Empty is legal and meaningful. */
function isIdentityString(value: unknown): value is string {
    return typeof value === 'string' && value.length <= MAX_IDENTITY_LENGTH;
}

function isInteractionFrame(message: object): message is InteractionFrame {
    const m = message as Record<string, unknown>;
    if (!Number.isSafeInteger(m['tick'])) return false;
    const events = m['events'];
    if (!Array.isArray(events) || events.length > MAX_INTERACTIONS_PER_FRAME) return false;
    return events.every(isInteraction);
}

function isInteraction(value: unknown): value is Interaction {
    if (typeof value !== 'object' || value === null) return false;
    const e = value as Record<string, unknown>;
    switch (e['kind']) {
        case 'press':
            return isWidgetName(e['widget']) && absentOr(e, 'screen', isWidgetName);
        case 'click':
        case 'hover-enter':
        case 'hover-exit':
            return Number.isSafeInteger(e['netId']) && (e['netId'] as number) >= 0;
        default:
            return false;
    }
}

function isRequestFrame(message: object): message is RequestFrame {
    const m = message as Record<string, unknown>;
    if (!Number.isSafeInteger(m['tick'])) return false;
    const requests = m['requests'];
    if (!Array.isArray(requests) || requests.length > MAX_REQUESTS_PER_FRAME) return false;
    return requests.every(isGameRequest);
}

function isGameRequest(value: unknown): value is GameRequest {
    if (typeof value !== 'object' || value === null) return false;
    const r = value as Record<string, unknown>;
    return (
        isRequestName(r['name']) &&
        absentOr(r, 'data', (data) => isPlainObject(data) && isAdmissiblePayload(data))
    );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimeSync(message: object): message is TimeSync {
    return Number.isFinite((message as Partial<TimeSync>).clientSentMs);
}

function isInputFrame(message: object): message is InputFrame {
    const m = message as Record<string, unknown>;
    if (!Number.isSafeInteger(m['tick']) || !Number.isSafeInteger(m['seq'])) return false;
    const actions = m['actions'];
    if (!Array.isArray(actions) || actions.length > MAX_ACTIONS_PER_FRAME) return false;
    return actions.every(isInputAction);
}

function isInputAction(value: unknown): value is InputAction {
    if (typeof value !== 'object' || value === null) return false;
    const a = value as Record<string, unknown>;
    if (!isActionName(a['action'])) return false;
    if (a['on'] !== 'press' && a['on'] !== 'release' && a['on'] !== 'hold') return false;
    return absentOr(a, 'value', Number.isFinite);
}
