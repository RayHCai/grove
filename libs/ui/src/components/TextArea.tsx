import { useId } from 'react';
import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from '../cx.js';

export interface TextAreaProps extends ComponentPropsWithRef<'textarea'> {
    /** The control's name; `labelHidden` keeps it for assistive technology only. */
    label: ReactNode;
    labelHidden?: boolean | undefined;
    /** A line under the control that also describes it. */
    hint?: ReactNode | undefined;
}

/** A labelled multi-line field with the same outlined control as `TextInput`, resizable downwards. */
export function TextArea({
    label,
    labelHidden = false,
    hint,
    id,
    className,
    'aria-describedby': describedBy,
    ...rest
}: TextAreaProps): React.JSX.Element {
    const generatedId = useId();
    const controlId = id ?? generatedId;
    const hintId = `${controlId}-hint`;
    const hasHint = hint !== undefined && hint !== null;
    const described = cx(describedBy, hasHint && hintId);
    return (
        <div className={cx('pg-field', 'pg-field--area', className)}>
            <label
                className={labelHidden ? 'pg-visually-hidden' : 'pg-field__label'}
                htmlFor={controlId}
            >
                {label}
            </label>
            <textarea
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
