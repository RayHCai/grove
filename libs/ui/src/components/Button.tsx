import type { ComponentPropsWithRef, MouseEvent, ReactNode } from 'react';
import { cx } from '../cx.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'md' | 'sm';

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
    variant?: ButtonVariant | undefined;
    size?: ButtonSize | undefined;
    icon?: ReactNode | undefined;
    iconEnd?: ReactNode | undefined;
}

/** Whether `aria-disabled` is set, so a still-focusable button swallows its clicks. */
export function isAriaDisabled(value: ComponentPropsWithRef<'button'>['aria-disabled']): boolean {
    return value === true || value === 'true';
}

/** The click handler an aria-disabled button takes instead of its own. */
export function swallowClick(event: MouseEvent<HTMLButtonElement>): void {
    event.preventDefault();
}

/** A 32px control in one of three variants, with optional icons either side of its label. */
export function Button({
    variant = 'secondary',
    size = 'md',
    icon,
    iconEnd,
    className,
    type = 'button',
    onClick,
    children,
    ...rest
}: ButtonProps): React.JSX.Element {
    const inert = isAriaDisabled(rest['aria-disabled']);
    return (
        <button
            type={type}
            className={cx('pg-btn', `pg-btn--${variant}`, size === 'sm' && 'pg-btn--sm', className)}
            onClick={inert ? swallowClick : onClick}
            {...rest}
        >
            <span className="pg-btn__label">
                {icon !== undefined && icon !== null && (
                    <span className="pg-btn__icon">{icon}</span>
                )}
                {children}
                {iconEnd !== undefined && iconEnd !== null && (
                    <span className="pg-btn__icon">{iconEnd}</span>
                )}
            </span>
        </button>
    );
}
