// The 22 names below already exist in three other places — @platform/math's barrel,
// @platform/engine's re-export block and .oxlintrc.json — and a test pins that all four agree,
// because a list that drifts is a SyncedScript that desyncs.

/** The transcendentals @platform/math reimplements, in @platform/engine's re-export order. */
export const TRANSCENDENTALS: readonly string[] = [
    'sin',
    'cos',
    'tan',
    'asin',
    'acos',
    'atan',
    'atan2',
    'sinh',
    'cosh',
    'tanh',
    'asinh',
    'acosh',
    'atanh',
    'exp',
    'expm1',
    'log',
    'log1p',
    'log2',
    'log10',
    'pow',
    'cbrt',
    'hypot',
];

/** What a denied form must be written as instead, and the reason it cannot stand. */
export interface Redirect {
    readonly use: string;
    readonly because: string;
}

const APPROXIMATED = 'every engine approximates it, and no two agree to the last bit';
const PRNG =
    "core's PRNGStore is the one draw sequence snapshot and rewind restore; an unseeded one cannot be replayed";
const NO_DOM =
    'the DOM exists on one end only, and a synced script must reach the same numbers on both';

/**
 * `Math` members denied inside a `SyncedScript`, keyed by member name.
 *
 * The rest of `Math` stays legal: `floor`, `abs`, `min`, `max`, `round`, `sqrt` and their kin are
 * exactly specified, so they already agree everywhere.
 */
export const DENIED_MATH: ReadonlyMap<string, Redirect> = new Map([
    ...TRANSCENDENTALS.map((name): [string, Redirect] => [
        name,
        {
            use: `\`${name}\` from @platform/engine`,
            because: `Math.${name} is approximated — ${APPROXIMATED}`,
        },
    ]),
    [
        'random',
        { use: '`random` from @platform/engine', because: `Math.random takes no seed — ${PRNG}` },
    ],
]);

/**
 * Globals denied inside a `SyncedScript`, keyed by binding name.
 *
 * `globalThis` and `process` are here although neither is a clock: `globalThis` is how every other
 * entry is reached without naming it, and `process` is absent in the browser half outright.
 */
export const DENIED_GLOBALS: ReadonlyMap<string, Redirect> = new Map<string, Redirect>([
    [
        'Date',
        {
            use: '`ctx.dt`, and `sleep` / `every` / `after` from @platform/engine',
            because:
                'wall-clock time differs on every machine; the tick is the only clock both ends share',
        },
    ],
    [
        'performance',
        {
            use: '`ctx.dt`, and `sleep` / `every` / `after` from @platform/engine',
            because: 'a high-resolution clock is still a clock, and its origin differs per process',
        },
    ],
    ['crypto', { use: '`random` from @platform/engine', because: PRNG }],
    [
        'fetch',
        {
            use: '`request` from @platform/engine, declared on a ServerScript',
            because: 'a synced script runs on both ends and only one of them may talk to the world',
        },
    ],
    [
        'globalThis',
        {
            use: 'the binding itself, named directly',
            because: 'reaching a global through globalThis is how this list is evaded',
        },
    ],
    [
        'process',
        {
            use: '@platform/engine',
            because: 'a synced script runs in the browser too, where process does not exist',
        },
    ],
    ...(
        [
            'window',
            'document',
            'navigator',
            'location',
            'localStorage',
            'sessionStorage',
            'history',
            'screen',
            'alert',
            'requestAnimationFrame',
            'cancelAnimationFrame',
            'XMLHttpRequest',
            'WebSocket',
            'Worker',
            'indexedDB',
        ] as const
    ).map((name): [string, Redirect] => [name, { use: 'a ClientScript', because: NO_DOM }]),
]);

/** Denied whenever `Math` is read as a value rather than as the object of a member access. */
export const ALIASED_MATH: Redirect = {
    use: 'the member call written out, as `Math.floor(x)`',
    because: 'an alias hides which member is reached, and only some of them are exact',
};

/** Denied for `Math[expr]`, where the member cannot be read off the syntax. */
export const COMPUTED_MATH: Redirect = {
    use: 'the member name written as a literal',
    because: 'a computed member cannot be checked before it runs',
};
