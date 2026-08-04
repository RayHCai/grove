// The per-instance plumbing behind a @serverState accessor pair (DESIGN §5.2).
//
// A @serverState field is never a data property: the getter reads a target map, the
// setter writes it and marks the state channel. Before wiring the target is a local
// backing map holding the authored value; wiring redirects it to the host record's
// values map, so `this.credits` and `player.credits` become one value.
//
// The accessor reads the target symbol at CALL time, so redirection is uniform across
// every field without touching the installed descriptors.

// Symbol.for so the src and dist module copies share identity — tests import backing from
// src while decorator fixtures are compiled to dist, and a plain Symbol() would differ
// between the two copies, breaking redirection.
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

/**
 * Installs the accessor pair for `field` on `instance`, moving the authored value into a
 * local backing map and deleting the data property (§5.2 step 2). Idempotent per field.
 */
export function installStateAccessor(instance: object, field: string): void {
    const holder = instance as StateHolder & Record<string, unknown>;
    const backing = (holder[STATE_BACKING] ??= new Map());
    holder[STATE_TARGET] ??= backing;

    // The authored value is an own data property at this point (§5.2: initializer ran).
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

/** True when `instance` has no own DATA property for `field` — the §5.2 invariant. */
export function hasNoDataProperty(instance: object, field: string): boolean {
    const desc = Object.getOwnPropertyDescriptor(instance, field);
    return desc === undefined || desc.get !== undefined || desc.set !== undefined;
}
