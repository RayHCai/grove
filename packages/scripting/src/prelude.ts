// The boilerplate a creator never sees. A Grove script is written with no imports at all — every
// engine name is a bare global on screen — so something has to put the import back above the file
// before a compiler reads it. Both places that compile a creator's source do it from this list.

/** The one module a compiled Grove script imports, and the only one a creator may reach. */
export const ENGINE_MODULE = '@platform/engine';

/**
 * Every engine name a compiled module may import.
 *
 * The type-only exports are not here: they are erased before a module is emitted, and importing
 * one would be a binding that does not exist. `@platform/engine` cannot be imported here to check
 * the list against — the dependency runs the other way — so the editor, which holds both, is where
 * a name the engine renamed fails a typecheck rather than a creator's game at run time.
 */
export const ENGINE_VALUES = [
    'clamp',
    'lerp',
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
    'BaseScript',
    'ServerScript',
    'ClientScript',
    'SyncedScript',
    'onStart',
    'onEnd',
    'onUpdate',
    'onClick',
    'onHoverEnter',
    'onHoverExit',
    'onPlayerJoin',
    'onPlayerLeave',
    'onEvent',
    'onEventRelease',
    'onEventHold',
    'onCollide',
    'onEnter',
    'onExit',
    'onPress',
    'onRequest',
    'serverState',
    'Entity',
    'Player',
    'Game',
    'Camera',
    'HUD',
    'HUDScreen',
    'Asset',
    'game',
    'hud',
    'random',
    'assets',
    'sound',
    'music',
    'sleep',
    'every',
    'after',
    'oscillate',
    'orbit',
    'tween',
    'request',
    'StatefulWrapper',
    'Countdown',
    'Storage',
    'Scoreboard',
    'Leaderboard',
    'Inventory',
    'Team',
    'BaseMovement',
    'TopDownMovement',
    'PlatformerMovement',
] as const;

/**
 * Every engine type a compiled module may import.
 *
 * Separate from the values because these are erased: importing one as a binding would be a name
 * that does not exist at run time. `@platform/engine` cannot be imported here to check the list
 * against — the dependency runs the other way — so the editor, which holds both this and the
 * declarations a creator is checked against, is where the two are held to agree.
 */
export const ENGINE_TYPES = [
    'Vec3',
    'Bounds',
    'Easing',
    'Ctx',
    'FindQuery',
    'Cursor',
    'InputBindings',
    'ActionState',
    'Collider',
    'Animation',
    'HUDAnchor',
    'AssetKind',
    'AssetRef',
    'SoundHandle',
    'SoundOptions',
    'Random',
    'Movement',
    'Concurrency',
    'EventPhase',
    'HandlerOptions',
    'HandlerDecorator',
    'StateDecorator',
    'Host',
    'ScriptQuery',
] as const;

/**
 * The one global a compiled module still needs that the engine does not export.
 *
 * Declared rather than taken from the DOM library, which a creator's program is compiled without:
 * `window`, `document` and the rest exist on one end only, and the two names this engine and that
 * library share — `Storage` and `Animation` — would collide outright.
 */
export const AMBIENT_DTS = `declare const console: {
    log(...values: unknown[]): void;
    info(...values: unknown[]): void;
    warn(...values: unknown[]): void;
    error(...values: unknown[]): void;
};
`;

/** Comments and plain strings, which are where a word that is not a use of anything lives. */
const NOT_CODE = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/gu;

/** A name standing on its own; one after a dot is a member of something else. */
const FREE_NAME = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)/gu;

/**
 * Every name a source reaches for itself.
 *
 * A member read is not one: `console.log` is not the engine's `log`, and importing it because the
 * word appeared would put a binding in the module that nothing there asked for.
 */
function namesIn(source: string): ReadonlySet<string> {
    const code = source.replaceAll(NOT_CODE, ' ');
    return new Set([...code.matchAll(FREE_NAME)].map((match) => match[1] ?? ''));
}

/**
 * Whether the file declares this name itself at its top level.
 *
 * A creator may call their own class `Storage`; the global is then shadowed, which the checker
 * allows — and importing the engine's beside it would be two declarations of one name, which no
 * module may have.
 */
function declaredIn(source: string, name: string): boolean {
    return new RegExp(
        String.raw`^(?:export\s+)?(?:const|let|var|function|class)\s+${name}\b`,
        'mu',
    ).test(source);
}

/** The engine names one source uses, in the engine's own order. */
export function engineNamesIn(source: string): readonly string[] {
    const names = namesIn(source);
    return ENGINE_VALUES.filter((name) => names.has(name) && !declaredIn(source, name));
}

/** The engine types one source names, in the engine's own order. */
export function engineTypesIn(source: string): readonly string[] {
    const names = namesIn(source);
    return ENGINE_TYPES.filter((name) => names.has(name) && !declaredIn(source, name));
}

/**
 * Whether a source reaches for this name and expects something else to have declared it.
 *
 * The test an injected binding is owed: a name the file reaches is a name it wants supplied, and a
 * name it declares itself is one a second declaration of would stop the module loading at all.
 */
export function usesFreeName(source: string, name: string): boolean {
    return namesIn(source).has(name) && !declaredIn(source, name);
}

/**
 * The import to put above this source, or `''` for a file that reaches no engine name.
 *
 * Only what the file uses: an import of every name would shadow the file's own declarations and
 * carry bindings into a module that never asked for them. A class named only as a type argument —
 * `ServerScript<Game>` — rides along anyway, since reading that off the text would take a parser
 * and what it imports is a real export either way.
 */
export function preludeFor(source: string): string {
    const used = engineNamesIn(source);
    return used.length === 0 ? '' : `import { ${used.join(', ')} } from '${ENGINE_MODULE}';\n`;
}

/**
 * The type import to put above this source, or `''` for a file that names no engine type.
 *
 * Separate from `preludeFor`, because the workbench needs only the values: it checks a creator's
 * file against ambient declarations that already carry every type. A compiler handed the file on
 * its own has no such declarations, so the types have to arrive the same way the values do.
 */
export function typePreludeFor(source: string): string {
    const used = engineTypesIn(source);
    return used.length === 0 ? '' : `import type { ${used.join(', ')} } from '${ENGINE_MODULE}';\n`;
}
