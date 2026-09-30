// The code, not the message text, is what a host branches on: a misconfigured world is a startup
// fault to fix, while an entry driven out of order is a host bug.

/** Every condition the sim throws on. */
export type SimErrorCode =
    /** A load-time config value the world cannot run on, such as a `simRate` of 0. */
    | 'invalid-config'
    /** `loadGame` returned no tick passes, so the input pass has nowhere to install. */
    | 'no-pass-table'
    /** The isolate entry was driven out of order: booted twice, or used before it was booted. */
    | 'entry-order';

/** A sim failure with a machine-readable {@link SimErrorCode}. */
export class SimError extends Error {
    readonly code: SimErrorCode;

    constructor(code: SimErrorCode, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'SimError';
        this.code = code;
    }
}

/** Throws a {@link SimError}. Keeps call sites to one line. */
export function simError(code: SimErrorCode, message: string, options?: ErrorOptions): never {
    throw new SimError(code, message, options);
}
