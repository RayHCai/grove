import { useState } from 'react';
import { Button, TextInput } from '@grove/ui';
import { PASSWORD_MAX, PASSWORD_MIN } from '@grove/api-contract';
import { messageOf } from '../api/messages';
import { Link } from '../router/Link';
import { go } from '../router/useRoute';
import { useSession } from '../session/SessionProvider';
import { AuthCard } from './AuthCard';

export interface SignUpProps {
    /** Where the editor asked to be sent back to, if it was the editor that sent somebody here. */
    returnTo: string | undefined;
}

/** Making an account: a name to be known by, an address, and a password. */
export function SignUp({ returnTo }: SignUpProps): React.JSX.Element {
    const { signUp, openEditor } = useSession();
    const [displayName, setDisplayName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [refusal, setRefusal] = useState<string | undefined>(undefined);
    const [busy, setBusy] = useState(false);

    const tooShort = password.length > 0 && password.length < PASSWORD_MIN;

    async function submit(): Promise<void> {
        if (tooShort) {
            setRefusal(`A password is at least ${String(PASSWORD_MIN)} characters.`);
            return;
        }
        setBusy(true);
        setRefusal(undefined);
        try {
            await signUp(email, password, displayName);
            if (returnTo === undefined) go({ at: 'games' });
            else openEditor(returnTo);
        } catch (failure) {
            setRefusal(messageOf(failure, 'That did not go through. Try again.'));
        } finally {
            setBusy(false);
        }
    }

    return (
        <AuthCard
            title="Create your Grove account"
            refusal={refusal}
            onSubmit={() => void submit()}
            footer={
                <>
                    Already have one? <Link to={{ at: 'sign-in', returnTo }}>Sign in</Link>
                </>
            }
        >
            <TextInput
                label="Display name"
                name="displayName"
                autoComplete="nickname"
                maxLength={64}
                required
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
            />
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
                {busy ? 'Creating your account…' : 'Create account'}
            </Button>
        </AuthCard>
    );
}
