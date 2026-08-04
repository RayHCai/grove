// The @serverState immutability constraint (DESIGN §5.2). The accessor observes only
// ASSIGNMENT; `this.scores.push(x)` and `this.config.hp = 20` never reach the setter, so
// a mutable declaration would replicate nothing. So a mutable declaration must fail to
// compile: the predicate collapses a mutable Value to a branded marker the real field
// type cannot satisfy.
//
// Primitives and string unions pass; readonly arrays/records/objects pass, recursively; a
// mutable array, object, or record is rejected — including a mutable element inside a
// readonly array.

declare const MUTABLE_BRAND: unique symbol;

/** The branded marker a mutable declaration collapses to. No real field type satisfies it. */
export interface MutableStateRejected {
    readonly [MUTABLE_BRAND]: 'a @serverState field must be immutable — DESIGN §5.2';
}

/** Deep-readonly check. `T` if immutable, the branded marker otherwise. */
export type Immutable<T> = IsDeeplyReadonly<T> extends true ? T : MutableStateRejected;

type IsDeeplyReadonly<T> = T extends (infer _E)[]
    ? false // a mutable array
    : T extends readonly (infer E)[]
      ? IsDeeplyReadonly<E>
      : T extends object
        ? T extends (...args: never[]) => unknown
            ? true // functions are opaque
            : HasMutableKey<T> extends true
              ? false
              : AllValuesReadonly<T>
        : true; // primitives

type HasMutableKey<T> = {
    [K in keyof T]-?: IfMutable<T, K, true, never>;
}[keyof T] extends never
    ? false
    : true;

type IfMutable<T, K extends keyof T, Yes, No> = (<G>() => G extends { [P in K]: T[P] } ? 1 : 2) extends <
    G,
>() => G extends { readonly [P in K]: T[P] } ? 1 : 2
    ? No
    : Yes;

type AllValuesReadonly<T> = {
    [K in keyof T]-?: IsDeeplyReadonly<T[K]>;
}[keyof T] extends true
    ? true
    : false;
