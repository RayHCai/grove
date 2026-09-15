import type { RejectReason } from '@platform/protocol';
import { useRef } from 'react';

/**
 * Why an authority turned a join away.
 *
 * Wider than the wire's own `RejectReason`: a ticket is checked before the upgrade, so its refusal
 * is an HTTP status that never becomes a reject envelope.
 */
export type RefusalReason = RejectReason | 'ticket';

export interface GamePlayerProps {
    /** Where the authority for this session listens. */
    serverUrl: string;
    /** The short-lived, session-scoped credential the allocator minted. Never a platform session. */
    ticket: string;
    onReady?: () => void;
    onRefused?: (reason: RefusalReason) => void;
}

/**
 * The canvas a game session mounts onto, addressed at the authority it was given.
 *
 * It holds no authority and checks nothing: every boundary that matters — admission, request
 * checking, ticket verification — is the authority's.
 */
export function GamePlayer({ serverUrl }: GamePlayerProps): React.JSX.Element {
    const canvas = useRef<HTMLCanvasElement>(null);
    return <canvas ref={canvas} data-server={serverUrl} />;
}
