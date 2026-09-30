import type { ComponentPropsWithRef, MouseEvent } from 'react';
import { ButtonLabel, buttonClass, iconButtonClass } from '@grove/ui';
import type { ButtonLook, IconButtonSize, IconButtonVariant } from '@grove/ui';
import { hrefOf, type Route } from './routes';
import { go } from './useRoute';

/**
 * Navigates in place for a plain click on an anchor whose `href` is `to`.
 *
 * A modifier or any button but the first means another tab or window, which is the browser's to
 * open rather than this app's to swallow, and so does a click a handler already prevented.
 */
export function navigateInPlace(to: Route, event: MouseEvent<HTMLAnchorElement>): void {
    if (event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (event.button !== 0) return;
    event.preventDefault();
    go(to);
}

export interface LinkProps extends Omit<ComponentPropsWithRef<'a'>, 'href'> {
    to: Route;
}

/**
 * A real anchor that navigates in place.
 *
 * `href` is set as well as handled, so the link can be middle-clicked, copied and read by anything
 * that looks at a page's links; a span with an `onClick` is none of those things.
 */
export function Link({ to, onClick, ...rest }: LinkProps): React.JSX.Element {
    return (
        <a
            href={hrefOf(to)}
            onClick={(event) => {
                onClick?.(event);
                navigateInPlace(to, event);
            }}
            {...rest}
        />
    );
}

export interface ButtonLinkProps extends LinkProps, ButtonLook {}

/** A `Link` drawn as the kit's button, for a control that goes somewhere rather than does something. */
export function ButtonLink({
    variant,
    size,
    cursor,
    className,
    children,
    ...rest
}: ButtonLinkProps): React.JSX.Element {
    return (
        <Link className={buttonClass({ variant, size, cursor }, className)} {...rest}>
            <ButtonLabel>{children}</ButtonLabel>
        </Link>
    );
}

export interface IconLinkProps extends Omit<LinkProps, 'aria-label'> {
    /** The accessible name; it is also the tooltip. */
    label: string;
    variant?: IconButtonVariant | undefined;
    size?: IconButtonSize | undefined;
}

/** A `Link` drawn as the kit's icon button, for a single glyph that goes somewhere. */
export function IconLink({
    label,
    variant,
    size,
    className,
    ...rest
}: IconLinkProps): React.JSX.Element {
    return (
        <Link
            className={iconButtonClass({ variant, size }, className)}
            aria-label={label}
            title={label}
            {...rest}
        />
    );
}
