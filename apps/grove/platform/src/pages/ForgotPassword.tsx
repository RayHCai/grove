import { useState } from 'react';
import { Button, TextInput } from '@grove/ui';
import { Link } from '../router/Link';
import { useAction } from '../session/useAction';
import { useSession } from '../session/SessionProvider';
import { AuthCard } from './AuthCard';

/** Asking for a reset link, and the one answer that does not say whether the address is registered. */
export function ForgotPassword(): React.JSX.Element {
    const { api } = useSession();
    const [email, setEmail] = useState('');
    const action = useAction();

    if (action.state.at === 'done') {
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
            refusal={action.refusal}
            onSubmit={() =>
                void action.run(
                    () => api.requestPasswordReset(email),
                    'That did not go through. Try again.',
                )
            }
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
            <Button
                type="submit"
                variant="primary"
                aria-busy={action.busy}
                aria-disabled={action.busy}
            >
                {action.busy ? 'Sending…' : 'Send the link'}
            </Button>
        </AuthCard>
    );
}
