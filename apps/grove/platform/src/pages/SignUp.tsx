import { useState } from 'react';
import { Button, TextInput } from '@grove/ui';
import { messageOf } from '../api/messages';
import { Link } from '../router/Link';
import { go } from '../router/useRoute';
import { useSession } from '../session/SessionProvider';
import { AuthCard } from './AuthCard';

/** The floor the service holds a password to; the field only says it once a password is under it. */
const MIN_PASSWORD = 12;

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

    const tooShort = password.length > 0 && password.length < MIN_PASSWORD;

    async function submit(): Promise<void> {
        if (tooShort) {
            setRefusal(`A password is at least ${String(MIN_PASSWORD)} characters.`);
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
                minLength={MIN_PASSWORD}
                aria-invalid={tooShort || undefined}
                hint={tooShort ? `At least ${String(MIN_PASSWORD)} characters.` : undefined}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
            />
            <Button type="submit" variant="primary" aria-busy={busy} aria-disabled={busy}>
                {busy ? 'Creating your account…' : 'Create account'}
            </Button>
        </AuthCard>
    );
}
