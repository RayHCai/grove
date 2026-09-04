// The code, not the message text, is what a host branches on: a misconfigured world is a startup
// fault to fix, while a bad call argument is one call to repair.

/** Every condition the sim throws on. */
export type SimErrorCode =
    /** A load-time config value the world cannot run on, such as a `simRate` of 0 or `maxPlayers` below 1. */
    | 'invalid-config'
    /** A call argument outside its contract, refused before anything was mutated. */
    | 'invalid-argument'
    /** `loadGame` returned no tick passes, so the input pass has nowhere to install. */
    | 'no-pass-table'
    /** The sim is closed, and the call would have advanced a world that has already been released. */
    | 'sim-closed';

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
