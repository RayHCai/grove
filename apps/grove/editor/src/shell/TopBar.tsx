import { useEffect, useState } from 'react';
import { Button, UserIcon, VisuallyHidden, Wordmark, iconButtonClass } from '@grove/ui';

/** Where the last save got to, which is the only thing the top bar reports. */
export type SaveState =
    { at: 'idle' } | { at: 'saving' } | { at: 'saved' } | { at: 'failed'; message: string };

export interface TopBarProps {
    title: string;
    displayName: string;
    /** Whether anything has been typed since the last save. */
    dirty: boolean;
    state: SaveState;
    onSave: () => void;
    /** The platform's profile page, which is where the account is looked after and signed out of. */
    profileHref: string;
}

/** How long "Saved" stays up before it fades. */
export const SAVED_FADE_MS = 10_000;

function wording(state: SaveState, dirty: boolean): string {
    switch (state.at) {
        case 'saving':
            return 'Saving…';
        case 'saved':
            return 'Saved';
        case 'failed':
            return state.message;
        default:
            return dirty ? 'Unsaved changes' : 'Up to date';
    }
}

/** The header: the brand, the game being edited, what a save last did, and the account. */
export function TopBar({
    title,
    displayName,
    dirty,
    state,
    onSave,
    profileHref,
}: TopBarProps): React.JSX.Element {
    // Keyed to the state object, so each new save restarts the clock.
    const [faded, setFaded] = useState<SaveState | null>(null);
    useEffect(() => {
        if (state.at !== 'saved') return;
        const timer = setTimeout(() => setFaded(state), SAVED_FADE_MS);
        return () => clearTimeout(timer);
    }, [state]);
    const fading = faded === state && !dirty;
    return (
        <header className="topbar">
            <VisuallyHidden as="h1">Grove editor</VisuallyHidden>
            <Wordmark />
            <span className="topbar__title">{title}</span>
            <span
                role="status"
                className={`topbar__state topbar__state--${state.at === 'failed' ? 'failed' : 'plain'}${fading ? ' topbar__state--faded' : ''}`}
            >
                {wording(state, dirty)}
            </span>
            <Button
                size="sm"
                cursor={false}
                className="topbar__save"
                aria-disabled={state.at === 'saving' || !dirty || undefined}
                onClick={onSave}
            >
                Save
            </Button>
            {/* A link, not a menu: the account lives on the platform, one origin for every
                credential, and the tab's exit save covers anything unsaved on the way out. */}
            <a
                href={profileHref}
                className={iconButtonClass({ variant: 'ghost' }, 'topbar__profile')}
                aria-label={`${displayName}: profile and sign out`}
                title={`${displayName}: profile and sign out`}
            >
                <UserIcon />
            </a>
        </header>
    );
}
