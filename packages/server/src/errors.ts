// The code, not the message text, is what a host branches on: a misconfigured server is a startup
// fault to fix, while a bad call argument is one call to repair.

/** Every condition the server throws on. */
export type ServerErrorCode =
    /** A load-time config value the server cannot run on, such as a `simRate` of 0 or `maxPlayers` below 1. */
    | 'invalid-config'
    /** A call argument outside its contract, refused before anything was mutated. */
    | 'invalid-argument'
    /** `loadGame` returned no tick passes, so the input pass has nowhere to install. */
    | 'no-pass-table'
    /** `start()` was called with no `TimerSource` injected, so nothing would ever tick. */
    | 'no-timer'
    /** The server is closed, and the call would have restarted a shut-down process. */
    | 'server-closed';

/** A server failure with a machine-readable {@link ServerErrorCode}. */
export class ServerError extends Error {
    readonly code: ServerErrorCode;

    constructor(code: ServerErrorCode, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'ServerError';
        this.code = code;
    }
}

/** Throws a {@link ServerError}. Keeps call sites to one line. */
export function serverError(code: ServerErrorCode, message: string, options?: ErrorOptions): never {
    throw new ServerError(code, message, options);
}
