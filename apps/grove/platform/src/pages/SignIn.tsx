import { useState } from 'react';
import { Button, TextInput } from '@grove/ui';
import { messageOf } from '../api/messages';
import { Link } from '../router/Link';
import { go } from '../router/useRoute';
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
    const [refusal, setRefusal] = useState<string | undefined>(undefined);
    const [busy, setBusy] = useState(false);

    async function submit(): Promise<void> {
        setBusy(true);
        setRefusal(undefined);
        try {
            if (!(await signIn(email, password))) {
                // The service answers a wrong address, a wrong password and a locked account the
                // same way, and saying which it was is the fact an enumeration is looking for.
                setRefusal('That address and password do not match an account.');
                return;
            }
            // Somebody the editor sent goes straight back to it, carrying the key it needs.
            if (returnTo === undefined) go({ at: 'games' });
            else openEditor(returnTo);
        } catch (failure) {
            setRefusal(messageOf(failure, 'Signing in did not go through. Try again.'));
        } finally {
            setBusy(false);
        }
    }

    return (
        <AuthCard
            title="Sign in to Grove"
            refusal={refusal}
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
            <Button type="submit" variant="primary" aria-busy={busy} aria-disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
            </Button>
            <p className="authcard__aside">
                <Link to={{ at: 'forgot-password' }}>Forgot your password?</Link>
            </p>
        </AuthCard>
    );
}
