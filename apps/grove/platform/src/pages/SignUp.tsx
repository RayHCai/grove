import { useState } from 'react';
import { Button, TextInput } from '@grove/ui';
import { Link } from '../router/Link';
import { go } from '../router/useRoute';
import { useAction } from '../session/useAction';
import { useSession } from '../session/SessionProvider';
import { AuthCard } from './AuthCard';
import { NewPasswordField, TOO_SHORT, tooShort } from './NewPasswordField';

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
    const action = useAction();

    function submit(): void {
        if (tooShort(password)) {
            action.fail(TOO_SHORT);
            return;
        }
        void action.run(async () => {
            await signUp(email, password, displayName);
            if (returnTo === undefined) go({ at: 'landing' });
            else openEditor(returnTo);
        }, 'That did not go through. Try again.');
    }

    return (
        <AuthCard
            title="Create your Grove account"
            refusal={action.refusal}
            onSubmit={submit}
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
            <NewPasswordField
                label="Password"
                name="password"
                value={password}
                onChange={setPassword}
            />
            <Button
                type="submit"
                variant="primary"
                aria-busy={action.busy}
                aria-disabled={action.busy}
            >
                {action.busy ? 'Creating your account…' : 'Create account'}
            </Button>
        </AuthCard>
    );
}
