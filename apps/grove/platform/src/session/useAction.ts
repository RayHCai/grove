import { useState } from 'react';
import { messageOf } from '@grove/ui';
import { isLapsedSession } from '../api/client';
import { useSession } from './SessionProvider';

/** Where one control's last request got to. */
export type ActionState =
    { at: 'idle' } | { at: 'busy' } | { at: 'done' } | { at: 'failed'; message: string };

export interface Action {
    state: ActionState;
    busy: boolean;
    /** What the last run was refused with, if it was. */
    refusal: string | undefined;
    /**
     * Runs one request: busy while it is out, then `done`, or `failed` with the sentence it threw.
     *
     * A string `work` answers is a refusal it read itself, such as a wrong password. A session the
     * service no longer recognises goes to sign in, which is the one failure not for this page.
     */
    run: (work: () => Promise<string | undefined | void>, fallback: string) => Promise<void>;
    /** Refuses without asking the service, for a field the page can check itself. */
    fail: (message: string) => void;
    reset: () => void;
}

/** The busy flag, the refusal and the lapsed session every form and button on this origin shares. */
export function useAction(): Action {
    const { lapsed } = useSession();
    const [state, setState] = useState<ActionState>({ at: 'idle' });

    return {
        state,
        busy: state.at === 'busy',
        refusal: state.at === 'failed' ? state.message : undefined,
        run: async (work, fallback) => {
            setState({ at: 'busy' });
            try {
                const refused = await work();
                setState(
                    typeof refused === 'string'
                        ? { at: 'failed', message: refused }
                        : { at: 'done' },
                );
            } catch (failure) {
                if (isLapsedSession(failure)) {
                    setState({ at: 'idle' });
                    lapsed();
                    return;
                }
                setState({ at: 'failed', message: messageOf(failure, fallback) });
            }
        },
        fail: (message) => setState({ at: 'failed', message }),
        reset: () => setState({ at: 'idle' }),
    };
}
