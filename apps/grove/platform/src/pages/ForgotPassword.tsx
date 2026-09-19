import { useState } from 'react';
import { Button, TextInput } from '@grove/ui';
import { messageOf } from '../api/messages';
import { Link } from '../router/Link';
import { useSession } from '../session/SessionProvider';
import { AuthCard } from './AuthCard';

/** Asking for a reset link, and the one answer that does not say whether the address is registered. */
export function ForgotPassword(): React.JSX.Element {
    const { api } = useSession();
    const [email, setEmail] = useState('');
    const [refusal, setRefusal] = useState<string | undefined>(undefined);
    const [busy, setBusy] = useState(false);
    const [sent, setSent] = useState(false);

    async function submit(): Promise<void> {
        setBusy(true);
        setRefusal(undefined);
        try {
            await api.requestPasswordReset(email);
            setSent(true);
        } catch (failure) {
            setRefusal(messageOf(failure, 'That did not go through. Try again.'));
        } finally {
            setBusy(false);
        }
    }

    if (sent) {
        return (
            <AuthCard
                title="The link is on its way"
                onSubmit={() => undefined}
                footer={<Link to={{ at: 'sign-in', returnTo: undefined }}>Back to sign in</Link>}
            >
                {/* The same words whether or not that address has an account: which addresses are
                    registered is not this page's to tell. */}
                <p className="authcard__note" role="status">
                    If {email} has a Grove account, a link to set a new password is in its inbox.
                    The link is good for one use.
                </p>
            </AuthCard>
        );
    }

    return (
        <AuthCard
            title="Forgot your password?"
            refusal={refusal}
            onSubmit={() => void submit()}
            footer={<Link to={{ at: 'sign-in', returnTo: undefined }}>Back to sign in</Link>}
        >
            <TextInput
                label="Email"
                type="email"
                name="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
            />
            <Button type="submit" variant="primary" aria-busy={busy} aria-disabled={busy}>
                {busy ? 'Sending…' : 'Send the link'}
            </Button>
        </AuthCard>
    );
}
