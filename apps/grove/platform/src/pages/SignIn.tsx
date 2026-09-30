import { useState } from 'react';
import { Button, TextInput } from '@grove/ui';
import { Link } from '../router/Link';
import { go } from '../router/useRoute';
import { useAction } from '../session/useAction';
import { useSession } from '../session/SessionProvider';
import { AuthCard } from './AuthCard';

export interface SignInProps {
    /** Where the editor asked to be sent back to, if it was the editor that sent somebody here. */
    returnTo: string | undefined;
}

/** The one page in Grove a password is typed on, and the way back to the editor after it. */
export function SignIn({ returnTo }: SignInProps): React.JSX.Element {
    const { signIn, openEditor } = useSession();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const action = useAction();

    function submit(): Promise<void> {
        return action.run(async () => {
            if (!(await signIn(email, password))) {
                // The service answers a wrong address, a wrong password and a locked account the
                // same way, and saying which it was is the fact an enumeration is looking for.
                return 'That address and password do not match an account.';
            }
            // Somebody the editor sent goes straight back to it, carrying the key it needs.
            if (returnTo === undefined) go({ at: 'landing' });
            else openEditor(returnTo);
            return undefined;
        }, 'Signing in did not go through. Try again.');
    }

    return (
        <AuthCard
            title="Sign in to Grove"
            refusal={action.refusal}
            onSubmit={() => void submit()}
            footer={
                <>
                    New here? <Link to={{ at: 'sign-up', returnTo }}>Create an account</Link>
                </>
            }
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
            <TextInput
                label="Password"
                type="password"
                name="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
            />
            <Button
                type="submit"
                variant="primary"
                aria-busy={action.busy}
                aria-disabled={action.busy}
            >
                {action.busy ? 'Signing in…' : 'Sign in'}
            </Button>
            <p className="authcard__aside">
                <Link to={{ at: 'forgot-password' }}>Forgot your password?</Link>
            </p>
        </AuthCard>
    );
}
