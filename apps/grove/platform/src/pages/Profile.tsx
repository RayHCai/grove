import { useState } from 'react';
import { Button, Eyebrow, Panel, SectionTitle, TextInput } from '@grove/ui';
import type { Account } from '@grove/api-contract';
import type { Api } from '../api/client';
import { isLapsedSession, messageOf } from '../api/messages';
import { go } from '../router/useRoute';
import { useSession } from '../session/SessionProvider';

/** The floor the service holds a password to, stated here so the field says it before the refusal. */
const MIN_PASSWORD = 12;

/** What one card's last write did. Every card on this page reports in these four states. */
type Wrote = { at: 'idle' | 'saving' | 'saved' } | { at: 'failed'; message: string };

function joined(iso: string): string {
    const when = new Date(iso);
    return Number.isNaN(when.getTime())
        ? 'date unknown'
        : when.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

export interface ProfileProps {
    account: Account;
}

/** The account and the four things its holder may do to it. */
export function Profile({ account }: ProfileProps): React.JSX.Element {
    const { api, accountChanged, forget } = useSession();

    return (
        <main className="zone">
            <header className="zone__head">
                <div>
                    <Eyebrow>{account.displayName}</Eyebrow>
                    <SectionTitle
                        as="h1"
                        subline={`With Grove since ${joined(account.createdAt)}.`}
                    >
                        Your profile
                    </SectionTitle>
                </div>
                <Button onClick={() => go({ at: 'games' })}>Your games</Button>
            </header>

            <NameCard account={account} onRenamed={accountChanged} api={api} />
            <PasswordCard api={api} />
            <CloseCard api={api} onClosed={forget} />
        </main>
    );
}

/** The two facts a profile is: the name others see, and the address only its holder does. */
function NameCard({
    account,
    onRenamed,
    api,
}: {
    account: Account;
    onRenamed: (account: Account) => void;
    api: Api;
}): React.JSX.Element {
    const [displayName, setDisplayName] = useState(account.displayName);
    const [state, setState] = useState<Wrote>({ at: 'idle' });

    const changed = displayName.trim() !== account.displayName;

    async function save(): Promise<void> {
        setState({ at: 'saving' });
        try {
            onRenamed(await api.rename(displayName.trim()));
            setState({ at: 'saved' });
        } catch (failure) {
            setState({ at: 'failed', message: messageOf(failure, 'That name was not saved.') });
        }
    }

    return (
        <Panel
            as="form"
            className="card"
            noValidate
            onSubmit={(event) => {
                event.preventDefault();
                void save();
            }}
        >
            <SectionTitle as="h2" subline="Other players see this on a leaderboard.">
                Display name
            </SectionTitle>
            <TextInput
                label="Display name"
                labelHidden
                name="displayName"
                maxLength={64}
                required
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
            />
            <TextInput
                label="Email"
                name="email"
                value={account.email}
                readOnly
                hint="Only you ever see this. It is the address a reset link goes to."
            />
            <div className="card__actions">
                <Button
                    type="submit"
                    variant="primary"
                    aria-busy={state.at === 'saving'}
                    aria-disabled={state.at === 'saving' || !changed || undefined}
                >
                    {state.at === 'saving' ? 'Saving…' : 'Save name'}
                </Button>
                <CardState state={state} saved="Saved." />
            </div>
        </Panel>
    );
}

/** Changing the password, which drops every other session the account was holding. */
function PasswordCard({ api }: { api: Api }): React.JSX.Element {
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [state, setState] = useState<Wrote>({ at: 'idle' });

    const tooShort = newPassword.length > 0 && newPassword.length < MIN_PASSWORD;

    async function save(): Promise<void> {
        if (tooShort) {
            setState({
                at: 'failed',
                message: `A password is at least ${String(MIN_PASSWORD)} characters.`,
            });
            return;
        }
        setState({ at: 'saving' });
        try {
            if ((await api.changePassword(currentPassword, newPassword)) === undefined) {
                setState({ at: 'failed', message: 'That is not your current password.' });
                return;
            }
            setCurrentPassword('');
            setNewPassword('');
            setState({ at: 'saved' });
        } catch (failure) {
            setState({
                at: 'failed',
                message: messageOf(failure, 'The password was not changed.'),
            });
        }
    }

    return (
        <Panel
            as="form"
            className="card"
            noValidate
            onSubmit={(event) => {
                event.preventDefault();
                void save();
            }}
        >
            <SectionTitle
                as="h2"
                subline="Changing it signs out everything else that was signed in."
            >
                Password
            </SectionTitle>
            <TextInput
                label="Current password"
                type="password"
                name="currentPassword"
                autoComplete="current-password"
                required
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
            />
            <TextInput
                label="New password"
                type="password"
                name="newPassword"
                autoComplete="new-password"
                required
                minLength={MIN_PASSWORD}
                aria-invalid={tooShort || undefined}
                hint={`At least ${String(MIN_PASSWORD)} characters.`}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
            />
            <div className="card__actions">
                <Button
                    type="submit"
                    variant="primary"
                    aria-busy={state.at === 'saving'}
                    aria-disabled={
                        state.at === 'saving' ||
                        currentPassword === '' ||
                        newPassword === '' ||
                        undefined
                    }
                >
                    {state.at === 'saving' ? 'Changing…' : 'Change password'}
                </Button>
                <CardState state={state} saved="Your password is changed." />
            </div>
        </Panel>
    );
}

/** Closing the account, which the service refuses while it still owns a game. */
function CloseCard({ api, onClosed }: { api: Api; onClosed: () => void }): React.JSX.Element {
    const [asked, setAsked] = useState(false);
    const [currentPassword, setCurrentPassword] = useState('');
    const [state, setState] = useState<Wrote>({ at: 'idle' });

    async function close(): Promise<void> {
        setState({ at: 'saving' });
        try {
            await api.closeAccount(currentPassword);
            onClosed();
            go({ at: 'landing' });
        } catch (failure) {
            if (isLapsedSession(failure)) {
                onClosed();
                go({ at: 'sign-in', returnTo: undefined });
                return;
            }
            setState({
                at: 'failed',
                message: messageOf(failure, 'The account was not closed.'),
            });
        }
    }

    return (
        <Panel
            as="form"
            face="warm"
            className="card"
            noValidate
            onSubmit={(event) => {
                event.preventDefault();
                void close();
            }}
        >
            <SectionTitle
                as="h2"
                subline="Delete your games first — Grove will not close an account that still owns one."
            >
                Close your account
            </SectionTitle>

            {asked ? (
                <>
                    <TextInput
                        label="Your password"
                        type="password"
                        name="currentPassword"
                        autoComplete="current-password"
                        required
                        value={currentPassword}
                        onChange={(event) => setCurrentPassword(event.target.value)}
                    />
                    <div className="card__actions">
                        <Button
                            type="submit"
                            aria-busy={state.at === 'saving'}
                            aria-disabled={
                                state.at === 'saving' || currentPassword === '' || undefined
                            }
                        >
                            {state.at === 'saving' ? 'Closing…' : 'Close it for good'}
                        </Button>
                        <Button
                            variant="ghost"
                            onClick={() => {
                                setAsked(false);
                                setCurrentPassword('');
                                setState({ at: 'idle' });
                            }}
                        >
                            Keep my account
                        </Button>
                        <CardState state={state} saved="" />
                    </div>
                </>
            ) : (
                <div className="card__actions">
                    <Button onClick={() => setAsked(true)}>Close my account</Button>
                </div>
            )}
        </Panel>
    );
}

/** What a card's last write did, in the one place all three of them report it. */
function CardState({ state, saved }: { state: Wrote; saved: string }): React.JSX.Element | null {
    if (state.at === 'failed') {
        return (
            <span className="card__refusal" role="alert">
                {state.message}
            </span>
        );
    }
    if (state.at === 'saved' && saved !== '') {
        return (
            <span className="card__saved" role="status">
                {saved}
            </span>
        );
    }
    return null;
}
