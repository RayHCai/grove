import { useId } from 'react';
import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from '../cx.js';

export interface TextInputProps extends ComponentPropsWithRef<'input'> {
    /** The control's name; `labelHidden` keeps it for assistive technology only. */
    label: ReactNode;
    labelHidden?: boolean | undefined;
    /** A line under the control that also describes it. */
    hint?: ReactNode | undefined;
}

/** A labelled single-line field: a 1px outlined control under a small muted label, with an optional hint. */
export function TextInput({
    label,
    labelHidden = false,
    hint,
    id,
    className,
    'aria-describedby': describedBy,
    ...rest
}: TextInputProps): React.JSX.Element {
    const generatedId = useId();
    const controlId = id ?? generatedId;
    const hintId = `${controlId}-hint`;
    const hasHint = hint !== undefined && hint !== null;
    const described = cx(describedBy, hasHint && hintId);
    return (
        <div className={cx('pg-field', className)}>
            <label
                className={labelHidden ? 'pg-visually-hidden' : 'pg-field__label'}
                htmlFor={controlId}
            >
                {label}
            </label>
            <input
                id={controlId}
                className="pg-field__control"
                aria-describedby={described === '' ? undefined : described}
                {...rest}
            />
            {hasHint && (
                <p className="pg-field__hint" id={hintId}>
                    {hint}
                </p>
            )}
        </div>
    );
}
