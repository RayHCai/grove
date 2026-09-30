import type { ComponentPropsWithRef, MouseEvent, ReactNode } from 'react';
import { cx } from '../cx.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'warm';
export type ButtonSize = 'md' | 'sm';

export interface ButtonLook {
    variant?: ButtonVariant | undefined;
    size?: ButtonSize | undefined;
    /** Whether the menu cursor steps in beside the label on hover; a toolbar button opts out. */
    cursor?: boolean | undefined;
}

export interface ButtonProps extends ComponentPropsWithRef<'button'>, ButtonLook {
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

/** The classes that draw a `Button`, for an element that has to be something else, such as a link. */
export function buttonClass(
    { variant = 'secondary', size = 'md', cursor = true }: ButtonLook = {},
    className?: string,
): string {
    return cx(
        'pg-btn',
        `pg-btn--${variant}`,
        size === 'sm' && 'pg-btn--sm',
        !cursor && 'pg-btn--no-cursor',
        className,
    );
}

/** A `--pg-ctl-h` control in one of four variants, with optional icons either side of its label. */
export function Button({
    variant,
    size,
    cursor,
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
            className={buttonClass({ variant, size, cursor }, className)}
            onClick={inert ? swallowClick : onClick}
            {...rest}
        >
            <ButtonLabel icon={icon} iconEnd={iconEnd}>
                {children}
            </ButtonLabel>
        </button>
    );
}

/** The label row inside anything drawn with `buttonClass`, which is where the cursor is painted. */
export function ButtonLabel({
    icon,
    iconEnd,
    children,
}: {
    icon?: ReactNode | undefined;
    iconEnd?: ReactNode | undefined;
    children?: ReactNode;
}): React.JSX.Element {
    return (
        <span className="pg-btn__label">
            {icon !== undefined && icon !== null && <span className="pg-btn__icon">{icon}</span>}
            {children}
            {iconEnd !== undefined && iconEnd !== null && (
                <span className="pg-btn__icon">{iconEnd}</span>
            )}
        </span>
    );
}
