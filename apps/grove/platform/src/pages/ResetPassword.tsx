import { useEffect, useRef, useState } from 'react';
import { Button, TextInput } from '@grove/ui';
import { PASSWORD_MAX, PASSWORD_MIN } from '@grove/api-contract';
import { messageOf } from '../api/messages';
import { Link } from '../router/Link';
import { replace } from '../router/useRoute';
import { useSession } from '../session/SessionProvider';
import { AuthCard } from './AuthCard';

export interface ResetPasswordProps {
    /** The key the reset mail linked with, which is a password until it is spent. */
    token: string | undefined;
}

/** Spending the key from a reset mail for a new password. */
export function ResetPassword({ token }: ResetPasswordProps): React.JSX.Element {
    const { api } = useSession();
    // Held before the effect below takes it out of the address bar, which re-renders this page with
    // no token left in the route to read.
    const held = useRef(token);
    const [password, setPassword] = useState('');
    const [refusal, setRefusal] = useState<string | undefined>(undefined);
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(false);

    /**
     * Out of the address bar as soon as it has been read.
     *
     * A URL reaches the history, a bookmark and the `Referer` of every request this page goes on to
     * make — and this one opens somebody's account until it is spent.
     */
    useEffect(() => {
        if (token !== undefined) replace({ at: 'reset-password', token: undefined });
    }, [token]);

    const key = held.current;
    const tooShort = password.length > 0 && password.length < PASSWORD_MIN;

    async function submit(): Promise<void> {
        if (key === undefined) return;
        if (tooShort) {
            setRefusal(`A password is at least ${String(PASSWORD_MIN)} characters.`);
            return;
        }
        setBusy(true);
        setRefusal(undefined);
        try {
            if (await api.resetPassword(key, password)) setDone(true);
            // Wrong, already spent and expired are one answer, so this page cannot say which.
            else setRefusal('That link is no longer good. Ask for a new one.');
        } catch (failure) {
            setRefusal(messageOf(failure, 'That did not go through. Try again.'));
        } finally {
            setBusy(false);
        }
    }

    if (done) {
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
            refusal={refusal}
            onSubmit={() => void submit()}
            footer={<Link to={{ at: 'sign-in', returnTo: undefined }}>Back to sign in</Link>}
        >
            <TextInput
                label="New password"
                type="password"
                name="newPassword"
                autoComplete="new-password"
                required
                minLength={PASSWORD_MIN}
                maxLength={PASSWORD_MAX}
                aria-invalid={tooShort || undefined}
                hint={tooShort ? `At least ${String(PASSWORD_MIN)} characters.` : undefined}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
            />
            <Button type="submit" variant="primary" aria-busy={busy} aria-disabled={busy}>
                {busy ? 'Setting it…' : 'Set the password'}
            </Button>
        </AuthCard>
    );
}
