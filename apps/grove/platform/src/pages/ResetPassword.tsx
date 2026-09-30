import { useEffect, useState } from 'react';
import { Button } from '@grove/ui';
import { Link } from '../router/Link';
import { replace } from '../router/useRoute';
import { useAction } from '../session/useAction';
import { useSession } from '../session/SessionProvider';
import { AuthCard } from './AuthCard';
import { NewPasswordField, TOO_SHORT, tooShort } from './NewPasswordField';

export interface ResetPasswordProps {
    /** The key the reset mail linked with, which is a password until it is spent. */
    token: string | undefined;
}

/** Spending the key from a reset mail for a new password. */
export function ResetPassword({ token }: ResetPasswordProps): React.JSX.Element {
    const { api } = useSession();
    // Taken once, before the effect below takes it out of the address bar, which re-renders this
    // page with no token left in the route to read.
    const [key] = useState(token);
    const [password, setPassword] = useState('');
    const action = useAction();

    /**
     * Out of the address bar as soon as it has been read.
     *
     * A URL reaches the history, a bookmark and the `Referer` of every request this page goes on to
     * make, and this one opens somebody's account until it is spent.
     */
    useEffect(() => {
        if (token !== undefined) replace({ at: 'reset-password', token: undefined });
    }, [token]);

    function submit(): void {
        if (key === undefined) return;
        if (tooShort(password)) {
            action.fail(TOO_SHORT);
            return;
        }
        void action.run(
            async () =>
                (await api.resetPassword(key, password))
                    ? undefined
                    : // Wrong, already spent and expired are one answer, so this page cannot say which.
                      'That link is no longer good. Ask for a new one.',
            'That did not go through. Try again.',
        );
    }

    if (action.state.at === 'done') {
        return (
            <AuthCard
                title="Your new password is set"
                onSubmit={() => undefined}
                footer={<Link to={{ at: 'sign-in', returnTo: undefined }}>Sign in</Link>}
            >
                {/* Spending a key signs nobody in and ends every session the account was holding:
                    a reset is what somebody does when they think the password was stolen. */}
                <p className="authcard__note" role="status">
                    Anything that was signed in to this account has been signed out. Sign in again
                    with the new password.
                </p>
            </AuthCard>
        );
    }

    if (key === undefined) {
        return (
            <AuthCard
                title="That link is missing its key"
                onSubmit={() => undefined}
                footer={<Link to={{ at: 'forgot-password' }}>Ask for a new link</Link>}
            >
                <p className="authcard__note" role="alert">
                    Open the link from the reset mail, or ask for another one.
                </p>
            </AuthCard>
        );
    }

    return (
        <AuthCard
            title="Set a new password"
            refusal={action.refusal}
            onSubmit={submit}
            footer={<Link to={{ at: 'sign-in', returnTo: undefined }}>Back to sign in</Link>}
        >
            <NewPasswordField
                label="New password"
                name="newPassword"
                value={password}
                onChange={setPassword}
            />
            <Button
                type="submit"
                variant="primary"
                aria-busy={action.busy}
                aria-disabled={action.busy}
            >
                {action.busy ? 'Setting it…' : 'Set the password'}
            </Button>
        </AuthCard>
    );
}
