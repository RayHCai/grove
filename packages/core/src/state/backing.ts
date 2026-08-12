// A @serverState field is never a data property: the accessors resolve the target map at call
// time, so wiring can redirect them at the host record's values without touching a descriptor.

// Symbol.for because the src and dist copies of core are both loaded — tests import from src
// while decorator fixtures are compiled to dist, and a plain Symbol() would not match.
/** Local authored-value map, and the redirectable target the accessors read. */
export const STATE_BACKING = Symbol.for('@platform/core:state-backing');
export const STATE_TARGET = Symbol.for('@platform/core:state-target');
/** `(field) => void`, installed by wiring; marks the state channel on a write. */
export const STATE_MARK = Symbol.for('@platform/core:state-mark');

interface StateHolder {
    [STATE_BACKING]?: Map<string, unknown>;
    [STATE_TARGET]?: Map<string, unknown>;
    [STATE_MARK]?: (field: string) => void;
}

/** Installs `field`'s accessor pair, moving the authored value into a local backing map. */
export function installStateAccessor(instance: object, field: string): void {
    const holder = instance as StateHolder & Record<string, unknown>;
    const backing = (holder[STATE_BACKING] ??= new Map());
    holder[STATE_TARGET] ??= backing;

    // The field initializer has already run, so the authored value is still an own data property.
    backing.set(field, holder[field]);
    delete holder[field];

    Object.defineProperty(instance, field, {
        configurable: true,
        enumerable: true,
        get(this: StateHolder) {
            return this[STATE_TARGET]!.get(field);
        },
        set(this: StateHolder, value: unknown) {
            this[STATE_TARGET]!.set(field, value);
            this[STATE_MARK]?.(field);
        },
    });
}

/** The authored value captured at construction, for the wiring seed / tag. */
export function authoredValue(instance: object, field: string): unknown {
    return (instance as StateHolder)[STATE_BACKING]?.get(field);
}

/** Redirects the instance's accessors at the host record's values map and installs marking. */
export function redirectState(
    instance: object,
    target: Map<string, unknown>,
    mark: (field: string) => void,
): void {
    const holder = instance as StateHolder;
    holder[STATE_TARGET] = target;
    holder[STATE_MARK] = mark;
}

/** True when `field` is an accessor or absent on `instance`, never an own data property. */
export function hasNoDataProperty(instance: object, field: string): boolean {
    const desc = Object.getOwnPropertyDescriptor(instance, field);
    return desc === undefined || desc.get !== undefined || desc.set !== undefined;
}
