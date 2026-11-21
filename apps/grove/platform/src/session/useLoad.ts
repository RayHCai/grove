import { useEffect, useEffectEvent, useState } from 'react';
import { messageOf } from '@grove/ui';
import { isLapsedSession } from '../api/client';
import { useSession } from './SessionProvider';

/** Where one read a page shows has got to. */
export type Loaded<T> =
    { at: 'loading' } | { at: 'loaded'; value: T } | { at: 'failed'; message: string };

export interface Load<T> {
    state: Loaded<T>;
    /** Reads again, from a failure's Try again. */
    retry: () => void;
    /** Replaces what is shown after the page changed it itself, loaded or not. */
    update: (change: (held: T | undefined) => T) => void;
}

/** One read a page shows, skipped while `read` is undefined: a lapsed session goes to sign in. */
export function useLoad<T>(
    read: (() => Promise<T>) | undefined,
    fallback: string,
    deps: readonly unknown[],
): Load<T> {
    const { lapsed } = useSession();
    const [state, setState] = useState<Loaded<T>>({ at: 'loading' });
    const [attempt, setAttempt] = useState(0);

    const reading = useEffectEvent(() => read?.());
    const refused = useEffectEvent((failure: unknown) => {
        if (isLapsedSession(failure)) {
            lapsed();
            return;
        }
        setState({ at: 'failed', message: messageOf(failure, fallback) });
    });

    const enabled = read !== undefined;
    useEffect(() => {
        if (!enabled) return undefined;
        // An answer that lands after the page moved on belongs to nobody.
        let live = true;
        reading()?.then(
            (value) => {
                if (live) setState({ at: 'loaded', value });
            },
            (failure: unknown) => {
                if (live) refused(failure);
            },
        );
        return () => {
            live = false;
        };
    }, [enabled, attempt, ...deps]);

    return {
        state,
        retry: () => {
            setState({ at: 'loading' });
            setAttempt((count) => count + 1);
        },
        update: (change) =>
            setState((held) => ({
                at: 'loaded',
                value: change(held.at === 'loaded' ? held.value : undefined),
            })),
    };
}
