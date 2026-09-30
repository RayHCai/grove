import { REQUEST_ID_HEADER } from '@grove/api-contract';

export interface FleetPeer {
    /** Where the peer answers, with no trailing path. */
    baseUrl: string;
    /** The fleet bearer the peer's `/v1` gate compares. */
    secret: string;
    /** How long a call may take unless the call names its own deadline. */
    timeoutMs: number;
}

export interface FleetCallInit extends RequestInit {
    timeoutMs?: number;
}

export type FleetCall = (
    path: string,
    requestId: string,
    init?: FleetCallInit,
) => Promise<Response>;

/**
 * One call to a fleet peer, carrying the bearer, the correlation id and a deadline.
 *
 * Rejects exactly as `fetch` does, so each caller decides what an unreachable peer means to it.
 */
export function fleetCall(peer: FleetPeer): FleetCall {
    const base = peer.baseUrl.replace(/\/+$/u, '');
    return async (path, requestId, init = {}) => {
        const { timeoutMs, ...request } = init;
        const headers = new Headers(request.headers);
        headers.set('authorization', `Bearer ${peer.secret}`);
        headers.set(REQUEST_ID_HEADER, requestId);
        return fetch(`${base}${path}`, {
            ...request,
            headers,
            signal: AbortSignal.timeout(timeoutMs ?? peer.timeoutMs),
        });
    };
}
