import { useRef } from 'react';

/** Why an authority turned a join away. */
export type RefusalReason = 'identity' | 'version' | 'ticket' | 'full';

export interface GamePlayerProps {
    /** Where the authority for this session listens. */
    serverUrl: string;
    /** The short-lived, session-scoped credential the allocator minted. Never a platform session. */
    ticket: string;
    onReady?: () => void;
    onRefused?: (reason: RefusalReason) => void;
}

/**
 * Mounts one game session onto a canvas.
 *
 * It holds no authority and checks nothing: the ticket is handed to the transport as given, and
 * every boundary that matters is the authority's.
 */
export function GamePlayer({ serverUrl }: GamePlayerProps): React.JSX.Element {
    const canvas = useRef<HTMLCanvasElement>(null);
    return <canvas ref={canvas} data-server={serverUrl} />;
}
