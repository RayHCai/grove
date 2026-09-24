import { SignedIn } from './accounts.js';
import { ErrorBody } from './errors.js';

/** A refusal the service named, kept apart from a network failure, which names nothing. */
export class ApiError extends Error {
    readonly code: ErrorBody['code'] | 'unreachable';
    readonly status: number;

    constructor(status: number, code: ApiError['code'], message: string) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
    }
}

/**
 * Whether a refusal means the browser is carrying no usable session, rather than an account that
 * is signed in but not allowed to do this.
 *
 * A 403 is deliberately excluded: `workspace`, `games` and `assets` all answer with one for a game
 * somebody else owns, which is a permission this account lacks, not a session it lost — bouncing
 * that to sign-in would ask an already-signed-in creator to sign in again for a game that was
 * never theirs. `status === 401` is kept alongside the code for whatever sits in front of the gate
 * and names nothing of its own.
 */
export function isLapsedSession(failure: unknown): boolean {
    return (
        failure instanceof ApiError && (failure.code === 'unauthorized' || failure.status === 401)
    );
}

export interface ApiClientOptions {
    baseUrl: string;
    /** Injected so a test drives the client without a server; the browser's own by default. */
    fetch?: typeof globalThis.fetch;
}

interface ParseableShape<T> {
    parse: (value: unknown) => T;
}

/**
 * The credentials, CSRF header and JSON-body plumbing every `@grove/api` client needs, whatever
 * routes it goes on to declare.
 */
export interface ApiBase {
    /** Every route that mints or renews a session hands back the token the next write must carry. */
    keep(signedIn: SignedIn): SignedIn;
    /** Drops the token when the session it belonged to ends, so nothing stale rides the next write. */
    forget(): void;
    /** The header a request built outside `call`/`write` — a keepalive send — still has to carry. */
    csrfHeader(): Record<string, string>;
    /** Throws on any refusal, including a network failure. */
    call(path: string, init?: RequestInit): Promise<Response>;
    /** A call whose one named status is an answer rather than a failure. */
    attempt(path: string, init: RequestInit, refused: number): Promise<Response | undefined>;
    /** The session a route minted or renewed, or nothing where that named status was the answer. */
    signedIn(response: Response | undefined): Promise<SignedIn | undefined>;
    read<T>(path: string, shape: ParseableShape<T>): Promise<T>;
    write<T>(path: string, method: string, body: unknown, shape: ParseableShape<T>): Promise<T>;
}

/** The one Vite define this package reaches for, cast rather than pulled in as a type dependency. */
interface ViteEnv {
    env?: { VITE_API_URL?: string };
}

/** Where the API is, which a build is told and a dev server defaults for. */
export function apiBaseUrl(): string {
    return (import.meta as unknown as ViteEnv).env?.VITE_API_URL ?? 'http://localhost:4000';
}

/**
 * The `@grove/api` client every app holds one of.
 *
 * The CSRF token is kept here rather than in a component: it arrives with a session read or a
 * sign-in and is demanded by every write after it, and a component that had to carry it between
 * the two is one that can drop it. The cookie itself is never touched — it is `HttpOnly` and
 * belongs to the API origin, and `credentials: 'include'` is the whole of what makes the browser
 * carry it across from this one.
 */
export function createApiBase({ baseUrl, fetch = globalThis.fetch }: ApiClientOptions): ApiBase {
    let csrfToken: string | undefined;

    function csrfHeader(): Record<string, string> {
        return csrfToken === undefined ? {} : { 'x-csrf-token': csrfToken };
    }

    async function send(path: string, init: RequestInit = {}): Promise<Response> {
        const response = await fetch(`${baseUrl}${path}`, {
            ...init,
            // The API is a different origin, and the session is a cookie: without this the browser
            // sends nothing and every route behind the gate answers as though nobody signed in.
            credentials: 'include',
            headers: { ...init.headers, ...csrfHeader() },
        }).catch(() => undefined);

        if (response === undefined) {
            throw new ApiError(0, 'unreachable', 'the Grove API could not be reached');
        }
        return response;
    }

    async function call(path: string, init: RequestInit = {}): Promise<Response> {
        const response = await send(path, init);
        if (!response.ok) throw await refusal(response);
        return response;
    }

    async function attempt(
        path: string,
        init: RequestInit,
        refused: number,
    ): Promise<Response | undefined> {
        const response = await send(path, init);
        if (response.status === refused) return undefined;
        if (!response.ok) throw await refusal(response);
        return response;
    }

    async function read<T>(path: string, shape: ParseableShape<T>): Promise<T> {
        return shape.parse(await (await call(path)).json());
    }

    async function write<T>(
        path: string,
        method: string,
        body: unknown,
        shape: ParseableShape<T>,
    ): Promise<T> {
        const response = await call(path, {
            method,
            ...(body === undefined ? {} : jsonBody(body)),
        });
        return shape.parse(await response.json());
    }

    function keep(minted: SignedIn): SignedIn {
        csrfToken = minted.csrfToken;
        return minted;
    }

    function forget(): void {
        csrfToken = undefined;
    }

    async function signedIn(response: Response | undefined): Promise<SignedIn | undefined> {
        if (response === undefined) return undefined;
        return keep(SignedIn.parse(await response.json()));
    }

    return { keep, forget, csrfHeader, call, attempt, signedIn, read, write };
}

/** A JSON body and the one header that makes the service parse it as one. */
export function jsonBody(body: unknown): RequestInit {
    return { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** The refusal the service wrote, or one named after the status when the body was not one. */
async function refusal(response: Response): Promise<ApiError> {
    const body = await response
        .json()
        .then((value: unknown) => ErrorBody.safeParse(value))
        .catch(() => undefined);
    return body?.success === true
        ? new ApiError(response.status, body.data.code, body.data.message)
        : new ApiError(response.status, 'internal', `the API answered ${String(response.status)}`);
}
