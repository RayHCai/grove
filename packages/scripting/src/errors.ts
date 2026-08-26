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

/** A determinism rule refused something: the build's static pass, or the runtime shim behind it. */
export class DeterminismError extends Error {
    /** Empty when the shim raised this at run time — it refuses one access, not a file. */
    readonly diagnostics: readonly Diagnostic[];

    constructor(message: string, diagnostics: readonly Diagnostic[] = []) {
        super(message);
        this.name = 'DeterminismError';
        this.diagnostics = diagnostics;
    }
}

/** The pipeline could not produce a chunk. */
export class BundleError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BundleError';
    }
}
