// A @serverState setter observes assignment only — `this.scores.push(x)` never reaches it and
// would replicate nothing — so a mutable declaration has to fail to compile instead.

declare const MUTABLE_BRAND: unique symbol;

/** The branded marker a mutable declaration collapses to. No real field type satisfies it. */
export interface MutableStateRejected {
    readonly [MUTABLE_BRAND]: 'a @serverState field must be immutable';
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
        : true;

type HasMutableKey<T> = {
    [K in keyof T]-?: IfMutable<T, K, true, never>;
}[keyof T] extends never
    ? false
    : true;

type IfMutable<T, K extends keyof T, Yes, No> =
    (<G>() => G extends { [P in K]: T[P] } ? 1 : 2) extends <G>() => G extends {
        readonly [P in K]: T[P];
    }
        ? 1
        : 2
        ? No
        : Yes;

type AllValuesReadonly<T> = {
    [K in keyof T]-?: IsDeeplyReadonly<T[K]>;
}[keyof T] extends true
    ? true
    : false;
