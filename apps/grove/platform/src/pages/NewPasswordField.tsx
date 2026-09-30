import { TextInput } from '@grove/ui';
import { PASSWORD_MAX, PASSWORD_MIN } from '@grove/api-contract';

/** The line a page refuses a short password with, before asking the service anything. */
export const TOO_SHORT = `A password is at least ${String(PASSWORD_MIN)} characters.`;

/** Whether what is typed so far is a password the service would refuse for its length. */
export function tooShort(password: string): boolean {
    return password.length > 0 && password.length < PASSWORD_MIN;
}

export interface NewPasswordFieldProps {
    label: string;
    name: string;
    value: string;
    onChange: (value: string) => void;
    /** Whether the length rule shows before anything is typed, rather than once it is broken. */
    hintAlways?: boolean | undefined;
    className?: string | undefined;
}

/** A password being chosen: the length the service holds it to, said where it is typed. */
export function NewPasswordField({
    label,
    name,
    value,
    onChange,
    hintAlways = false,
    className,
}: NewPasswordFieldProps): React.JSX.Element {
    const short = tooShort(value);
    return (
        <TextInput
            label={label}
            className={className}
            type="password"
            name={name}
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN}
            maxLength={PASSWORD_MAX}
            aria-invalid={short || undefined}
            hint={hintAlways || short ? `At least ${String(PASSWORD_MIN)} characters.` : undefined}
            value={value}
            onChange={(event) => onChange(event.target.value)}
        />
    );
}
