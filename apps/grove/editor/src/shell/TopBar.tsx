import { Button, IconButton, UserIcon, VisuallyHidden, Wordmark } from '@grove/ui';

/** Where the last save got to, which is the only thing the top bar reports. */
export type SaveState =
    | { at: 'idle' }
    | { at: 'saving' }
    | { at: 'saved'; revision: number }
    | { at: 'failed'; message: string };

export interface TopBarProps {
    title: string;
    displayName: string;
    /** Whether anything has been typed since the last save. */
    dirty: boolean;
    state: SaveState;
    onSave: () => void;
}

function wording(state: SaveState, dirty: boolean): string {
    switch (state.at) {
        case 'saving':
            return 'Saving…';
        case 'saved':
            return `Saved as revision ${String(state.revision)}`;
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
}: TopBarProps): React.JSX.Element {
    return (
        <header className="topbar">
            <VisuallyHidden as="h1">Grove editor</VisuallyHidden>
            <Wordmark />
            <span className="topbar__title">{title}</span>
            <span
                role="status"
                className={`topbar__state topbar__state--${state.at === 'failed' ? 'failed' : 'plain'}`}
            >
                {wording(state, dirty)}
            </span>
            <Button
                size="sm"
                className="topbar__save"
                aria-disabled={state.at === 'saving' || !dirty || undefined}
                onClick={onSave}
            >
                Save
            </Button>
            <IconButton label={displayName} variant="ghost" className="topbar__profile">
                <UserIcon />
            </IconButton>
        </header>
    );
}
