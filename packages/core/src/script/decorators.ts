// Standard (TC39 Stage 3) decorators. Only this file knows how a HandlerDecl was
// produced; the registry, dispatcher, wiring and hosts store a neutral record, so
// nothing in the dispatch/loop/entity code depends on the decorator model (DESIGN §3.3).
//
// Symbol.metadata does not exist on node 24 — the one-line polyfill below is load-
// bearing and verified (DESIGN §3.3).

import type { HandlerKind } from './metadata.js';
import { getOrCreateMetadata, ensureOwnHandlers, ensureOwnState } from './metadata.js';
import type { HandlerOptions, Concurrency } from './types.js';

// ─── polyfill ────────────────────────────────────────────────────────────────────
(Symbol as { metadata?: symbol }).metadata ??= Symbol('Symbol.metadata');

// ─── handler decorators ──────────────────────────────────────────────────────────

function handlerDecorator(
    kind: HandlerKind,
    event: string,
    opts?: HandlerOptions,
): MethodDecorator_ {
    return (_value, context) => {
        const md = getOrCreateMetadata(context.metadata);
        const handlers = ensureOwnHandlers(md, context.metadata);
        const methodName = String(context.name);
        const existing = handlers.find(h => h.methodName === methodName);
        if (!existing) {
            handlers.push({ event, kind, methodName, opts: opts ?? {} });
        }
    };
}

export const onStart: MethodDecorator_ = handlerDecorator('onStart', '@start');
export const onEnd: MethodDecorator_ = handlerDecorator('onEnd', '@end');
export const onUpdate: MethodDecorator_ = handlerDecorator('onUpdate', '@update');
export const onClick: MethodDecorator_ = handlerDecorator('onClick', '@click');
export const onHoverEnter: MethodDecorator_ = handlerDecorator('onHoverEnter', '@hoverEnter');
export const onHoverExit: MethodDecorator_ = handlerDecorator('onHoverExit', '@hoverExit');
export const onPlayerJoin: MethodDecorator_ = handlerDecorator('onPlayerJoin', '@playerJoin');
export const onPlayerLeave: MethodDecorator_ = handlerDecorator('onPlayerLeave', '@playerLeave');

export function onEvent(event: string, opts?: HandlerOptions): MethodDecorator_ {
    return handlerDecorator('onEvent', event, opts);
}

export function onEventRelease(event: string, opts?: HandlerOptions): MethodDecorator_ {
    return handlerDecorator('onEvent', event, { ...opts, on: 'release' });
}

export function onEventHold(event: string, opts?: HandlerOptions): MethodDecorator_ {
    return handlerDecorator('onEvent', event, { ...opts, on: 'hold' });
}

export function onCollide(tag: string, opts?: HandlerOptions): MethodDecorator_ {
    return handlerDecorator('onCollide', tag, opts);
}

export function onEnter(region: string): MethodDecorator_ {
    return handlerDecorator('onEnter', region);
}

export function onExit(region: string): MethodDecorator_ {
    return handlerDecorator('onExit', region);
}

export function onPress(widget: string): MethodDecorator_ {
    return handlerDecorator('onPress', widget);
}

export function onRequest(name: string, opts?: HandlerOptions): MethodDecorator_ {
    return handlerDecorator('onRequest', name, opts);
}

// ─── @serverState ────────────────────────────────────────────────────────────────

export const serverState: FieldDecorator_ = (_value, context) => {
    const md = getOrCreateMetadata(context.metadata);
    const state = ensureOwnState(md, context.metadata);
    state.add(String(context.name));
    return (initial) => initial;
};

// ─── type helpers ────────────────────────────────────────────────────────────────

type MethodDecorator_ = <This, Args extends unknown[], Return>(
    value: (this: This, ...args: Args) => Return,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>,
) => void;

type FieldDecorator_ = <This, Value>(
    value: undefined,
    context: ClassFieldDecoratorContext<This, Value>,
) => (this: This, initial: Value) => Value;

// ─── concurrency helper ──────────────────────────────────────────────────────────

export function defaultConcurrency(kind: HandlerKind): Concurrency {
    switch (kind) {
        case 'onCollide':
        case 'onEnter':
        case 'onExit':
            return 'concurrent';
        default:
            return 'ignore';
    }
}
