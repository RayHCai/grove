/** One refusal, at the source position that caused it. */
export interface Diagnostic {
    /** POSIX-relative to the analysed source root, so a message reads the same on every machine. */
    readonly file: string;
    readonly line: number;
    readonly column: number;
    /** The `SyncedScript` subclass the reference sits in. */
    readonly klass: string;
    /** What was written — `Date`, `Math.sin`, `Math[expr]`. */
    readonly found: string;
    /** What to write instead. */
    readonly use: string;
    readonly because: string;
}

/** `file:line:column — Klass reads X. Use Y; because Z.` */
export function formatDiagnostic(d: Diagnostic): string {
    return `${d.file}:${d.line}:${d.column} — ${d.klass} reads ${d.found}. Use ${d.use}; ${d.because}.`;
}

/** A determinism rule refused something: the build's static pass, or a realm shim behind it. */
export class DeterminismError extends Error {
    /** Empty when a shim raised this at run time — it refuses one access, not a file. */
    readonly diagnostics: readonly Diagnostic[];

    constructor(message: string, diagnostics: readonly Diagnostic[] = []) {
        super(message);
        this.name = 'DeterminismError';
        this.diagnostics = diagnostics;
    }
}

/** Every condition the toolchain refuses to produce a chunk on. */
export type BundleErrorCode =
    /** A directory under the source root could not be listed. */
    | 'source-unreadable'
    /** A source file is not parseable TypeScript. */
    | 'parse-failed'
    /** The tsconfig handed to `lowerScripts` is not on disk. */
    | 'tsconfig-missing'
    /** `tsc` could not be spawned at all, so nothing was compiled. */
    | 'tsc-unavailable'
    /** `tsc` ran and reported errors. */
    | 'tsc-failed'
    /** A declared module has no lowered `.js`, so the analysed root is not the `rootDir`. */
    | 'lowered-module-missing'
    /** A side linked into more than one chunk, which a dynamic import in a script module causes. */
    | 'chunk-split'
    /** Two script classes claim one id. */
    | 'duplicate-id'
    /** A `ScriptRef` names a module and export that no script class was found under. */
    | 'unknown-script';

/** The pipeline could not produce a chunk, with a machine-readable {@link BundleErrorCode}. */
export class BundleError extends Error {
    readonly code: BundleErrorCode;

    constructor(code: BundleErrorCode, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'BundleError';
        this.code = code;
    }
}
