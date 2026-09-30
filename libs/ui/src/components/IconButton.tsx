import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from '../cx.js';
import { isAriaDisabled, swallowClick } from './Button.js';

export type IconButtonVariant = 'primary' | 'secondary' | 'ghost';
export type IconButtonSize = 'md' | 'sm';

export interface IconButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'aria-label'> {
    /** The accessible name; it is also the tooltip unless `title` is given. */
    label: string;
    pressed?: boolean | undefined;
    variant?: IconButtonVariant | undefined;
    size?: IconButtonSize | undefined;
    children: ReactNode;
}

/** The classes that draw an `IconButton`, for an element that has to be something else, such as a link. */
export function iconButtonClass(
    {
        variant = 'secondary',
        size = 'md',
    }: { variant?: IconButtonVariant | undefined; size?: IconButtonSize | undefined } = {},
    className?: string,
): string {
    return cx('pg-iconbtn', `pg-iconbtn--${variant}`, size === 'sm' && 'pg-iconbtn--sm', className);
}

/** A square button holding one icon, in the same variants and sizes as `Button`. */
export function IconButton({
    label,
    pressed,
    variant = 'secondary',
    size = 'md',
    className,
    title,
    type = 'button',
    onClick,
    children,
    ...rest
}: IconButtonProps): React.JSX.Element {
    const inert = isAriaDisabled(rest['aria-disabled']);
    return (
        <button
            type={type}
            className={iconButtonClass({ variant, size }, className)}
            aria-label={label}
            aria-pressed={pressed}
            title={title ?? label}
            onClick={inert ? swallowClick : onClick}
            {...rest}
        >
            {children}
        </button>
    );
}
