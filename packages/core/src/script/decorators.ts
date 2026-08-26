// Standard TC39 decorators, whose two shapes are named here so a creator can annotate one without
// importing the TC39 context types. Symbol.metadata is absent on node 24 and without the polyfill
// below every table silently stays empty.

import type { HandlerKind } from './metadata.js';
import { getOrCreateMetadata } from './metadata.js';
import type { HandlerOptions, Concurrency } from './types.js';
import { installStateAccessor } from '../state/backing.js';

(Symbol as { metadata?: symbol }).metadata ??= Symbol('Symbol.metadata');

function handlerDecorator(
    kind: HandlerKind,
    event: string,
    opts?: HandlerOptions,
): HandlerDecorator {
    return (_value, context) => {
        const handlers = getOrCreateMetadata(context.metadata).handlers;
        const methodName = String(context.name);
        const existing = handlers.find((h) => h.methodName === methodName);
        if (!existing) {
            handlers.push({ event, kind, methodName, opts: opts ?? {} });
        }
    };
}

export const onStart: HandlerDecorator = handlerDecorator('onStart', '@start');
export const onEnd: HandlerDecorator = handlerDecorator('onEnd', '@end');
export const onUpdate: HandlerDecorator = handlerDecorator('onUpdate', '@update');
export const onClick: HandlerDecorator = handlerDecorator('onClick', '@click');
export const onHoverEnter: HandlerDecorator = handlerDecorator('onHoverEnter', '@hoverEnter');
export const onHoverExit: HandlerDecorator = handlerDecorator('onHoverExit', '@hoverExit');
export const onPlayerJoin: HandlerDecorator = handlerDecorator('onPlayerJoin', '@playerJoin');
export const onPlayerLeave: HandlerDecorator = handlerDecorator('onPlayerLeave', '@playerLeave');

export function onEvent(event: string, opts?: HandlerOptions): HandlerDecorator {
    return handlerDecorator('onEvent', event, opts);
}

export function onEventRelease(event: string, opts?: HandlerOptions): HandlerDecorator {
    return handlerDecorator('onEvent', event, { ...opts, on: 'release' });
}

export function onEventHold(event: string, opts?: HandlerOptions): HandlerDecorator {
    return handlerDecorator('onEvent', event, { ...opts, on: 'hold' });
}

export function onCollide(tag: string, opts?: HandlerOptions): HandlerDecorator {
    return handlerDecorator('onCollide', tag, opts);
}

export function onEnter(region: string): HandlerDecorator {
    return handlerDecorator('onEnter', region);
}

export function onExit(region: string): HandlerDecorator {
    return handlerDecorator('onExit', region);
}

export function onPress(widget: string): HandlerDecorator {
    return handlerDecorator('onPress', widget);
}

export function onRequest(name: string, opts?: HandlerOptions): HandlerDecorator {
    return handlerDecorator('onRequest', name, opts);
}

export const serverState: StateDecorator = (_value, context) => {
    const field = String(context.name);
    getOrCreateMetadata(context.metadata).state.add(field);

    // addInitializer runs after the field is defined, so the authored value is an own data
    // property when installStateAccessor swaps it for the accessor pair.
    context.addInitializer(function (this: unknown) {
        installStateAccessor(this as object, field);
    });

    // The authored value passes through untouched: one evaluation, and no mark on construction.
    return (initial) => initial;
};

/** Every handler decorator: generic over the method it wraps, so a decorated method keeps its exact signature. */
export type HandlerDecorator = <This, Args extends unknown[], Return>(
    value: (this: This, ...args: Args) => Return,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>,
) => void;

/** The `@serverState` shape: `value` is always undefined, and the returned initializer runs per instance. */
export type StateDecorator = <This, Value>(
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
