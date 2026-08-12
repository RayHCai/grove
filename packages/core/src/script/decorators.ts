// Standard TC39 decorators, contained here so nothing downstream depends on the decorator
// model. Symbol.metadata is absent on node 24 and without the polyfill below every table
// silently stays empty.

import type { HandlerKind } from './metadata.js';
import { getOrCreateMetadata, ensureOwnHandlers, ensureOwnState } from './metadata.js';
import type { HandlerOptions, Concurrency } from './types.js';
import { installStateAccessor } from '../state/backing.js';

(Symbol as { metadata?: symbol }).metadata ??= Symbol('Symbol.metadata');

function handlerDecorator(
    kind: HandlerKind,
    event: string,
    opts?: HandlerOptions,
): MethodDecorator_ {
    return (_value, context) => {
        const md = getOrCreateMetadata(context.metadata);
        const handlers = ensureOwnHandlers(md, context.metadata);
        const methodName = String(context.name);
        const existing = handlers.find((h) => h.methodName === methodName);
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

export const serverState: FieldDecorator_ = (_value, context) => {
    const md = getOrCreateMetadata(context.metadata);
    const state = ensureOwnState(md, context.metadata);
    const field = String(context.name);
    state.add(field);

    // addInitializer runs after the field is defined, so the authored value is an own data
    // property when installStateAccessor swaps it for the accessor pair.
    context.addInitializer(function (this: unknown) {
        installStateAccessor(this as object, field);
    });

    // The authored value passes through untouched: one evaluation, and no mark on construction.
    return (initial) => initial;
};

type MethodDecorator_ = <This, Args extends unknown[], Return>(
    value: (this: This, ...args: Args) => Return,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>,
) => void;

type FieldDecorator_ = <This, Value>(
    value: undefined,
    context: ClassFieldDecoratorContext<This, Value>,
) => (this: This, initial: Value) => Value;

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
