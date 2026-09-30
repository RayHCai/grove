import { useState } from 'react';
import { Button, SectionTitle, TextInput, VisuallyHidden } from '@grove/ui';
import type { Account } from '@grove/api-contract';
import { FormPanel } from '../chrome/FormPanel';
import { go } from '../router/useRoute';
import { useAction } from '../session/useAction';
import type { ActionState } from '../session/useAction';
import { useSession } from '../session/SessionProvider';
import { NewPasswordField, TOO_SHORT, tooShort } from './NewPasswordField';

export interface ProfileProps {
    account: Account;
}

/** The account and the four things its holder may do to it. */
export function Profile({ account }: ProfileProps): React.JSX.Element {
    return (
        <main className="zone">
            <VisuallyHidden as="h1">Your profile</VisuallyHidden>
            <NameCard account={account} />
            <PasswordCard />
            <CloseCard />
        </main>
    );
}

/** The two facts a profile is: the name others see, and the address only its holder does. */
function NameCard({ account }: { account: Account }): React.JSX.Element {
    const { api, accountChanged } = useSession();
    const [displayName, setDisplayName] = useState(account.displayName);
    const action = useAction();

    const changed = displayName.trim() !== account.displayName;

    return (
        <FormPanel
            className="card"
            onSubmit={() =>
                void action.run(async () => {
                    accountChanged(await api.rename(displayName.trim()));
                }, 'That name was not saved.')
            }
        >
            <SectionTitle as="h2" subline="Other players see this on a leaderboard.">
                Display name
            </SectionTitle>
            <TextInput
                label="Display name"
                labelHidden
                className="card__field"
                name="displayName"
                maxLength={64}
                required
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
            />
            <TextInput
                label="Email"
                className="card__field"
                name="email"
                value={account.email}
                readOnly
                hint="Only you ever see this. It is the address a reset link goes to."
            />
            <div className="card__actions">
                <Button
                    type="submit"
                    variant="primary"
                    aria-busy={action.busy}
                    aria-disabled={action.busy || !changed || undefined}
                >
                    {action.busy ? 'Saving…' : 'Save name'}
                </Button>
                <CardState state={action.state} done="Saved." />
            </div>
        </FormPanel>
    );
}

/** Changing the password, which drops every other session the account was holding. */
function PasswordCard(): React.JSX.Element {
    const { api } = useSession();
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const action = useAction();

    function save(): void {
        if (tooShort(newPassword)) {
            action.fail(TOO_SHORT);
            return;
        }
        void action.run(async () => {
            if ((await api.changePassword(currentPassword, newPassword)) === undefined) {
                return 'That is not your current password.';
            }
            setCurrentPassword('');
            setNewPassword('');
            return undefined;
        }, 'The password was not changed.');
    }

    return (
        <FormPanel className="card" onSubmit={save}>
            <SectionTitle
                as="h2"
                subline="Changing it signs out everything else that was signed in."
            >
                Password
            </SectionTitle>
            <TextInput
                label="Current password"
                className="card__field"
                type="password"
                name="currentPassword"
                autoComplete="current-password"
                required
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
            />
            <NewPasswordField
                label="New password"
                name="newPassword"
                hintAlways
                className="card__field"
                value={newPassword}
                onChange={setNewPassword}
            />
            <div className="card__actions">
                <Button
                    type="submit"
                    variant="primary"
                    aria-busy={action.busy}
                    aria-disabled={
                        action.busy || currentPassword === '' || newPassword === '' || undefined
                    }
                >
                    {action.busy ? 'Changing…' : 'Change password'}
                </Button>
                <CardState state={action.state} done="Your password is changed." />
            </div>
        </FormPanel>
    );
}

/** Closing the account, which the service refuses while it still owns a game. */
function CloseCard(): React.JSX.Element {
    const { api, forget } = useSession();
    const [asked, setAsked] = useState(false);
    const [currentPassword, setCurrentPassword] = useState('');
    const action = useAction();

    return (
        <FormPanel
            face="warm"
            className="card"
            onSubmit={() =>
                void action.run(async () => {
                    await api.closeAccount(currentPassword);
                    forget();
                    go({ at: 'landing' });
                }, 'The account was not closed.')
            }
        >
            <SectionTitle
                as="h2"
                subline="Delete your games first: Grove will not close an account that still owns one."
            >
                Close your account
            </SectionTitle>

            {asked ? (
                <>
                    <TextInput
                        label="Your password"
                        className="card__field"
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
                            aria-busy={action.busy}
                            aria-disabled={action.busy || currentPassword === '' || undefined}
                        >
                            {action.busy ? 'Closing…' : 'Close it for good'}
                        </Button>
                        <Button
                            variant="ghost"
                            onClick={() => {
                                setAsked(false);
                                setCurrentPassword('');
                                action.reset();
                            }}
                        >
                            Keep my account
                        </Button>
                        <CardState state={action.state} done="" />
                    </div>
                </>
            ) : (
                <div className="card__actions">
                    <Button onClick={() => setAsked(true)}>Close my account</Button>
                </div>
            )}
        </FormPanel>
    );
}

/** What a card's last write did, in the one place all three of them report it. */
function CardState({
    state,
    done,
}: {
    state: ActionState;
    done: string;
}): React.JSX.Element | null {
    if (state.at === 'failed') {
        return (
            <span className="card__refusal" role="alert">
                {state.message}
            </span>
        );
    }
    if (state.at === 'done' && done !== '') {
        return (
            <span className="card__saved" role="status">
                {done}
            </span>
        );
    }
    return null;
}
