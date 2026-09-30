import { useEffect, useEffectEvent, useRef } from 'react';
import type { ComponentPropsWithoutRef, KeyboardEvent, ReactNode, RefObject } from 'react';
import { cx } from '../cx.js';

export type MenuCloseReason = 'escape' | 'tab' | 'outside';

export interface MenuProps extends Omit<ComponentPropsWithoutRef<'div'>, 'role' | 'aria-label'> {
    /** The accessible name. */
    label: string;
    open: boolean;
    /** Escape, Tab out, or a press outside `within`; the caller decides where focus goes next. */
    onClose: (reason: MenuCloseReason) => void;
    /** Where a press still counts as inside, usually the menu and its trigger; the menu by default. */
    within?: RefObject<HTMLElement | null> | undefined;
    children: ReactNode;
}

const ITEMS = '[role="menuitem"]:not([aria-disabled="true"])';

/** The classes a menu row takes, for a row that is a link rather than a `MenuItem`. */
export function menuItemClass(className?: string): string {
    return cx('pg-menu__item', className);
}

/**
 * A menu: focus lands on the first item when it opens, and the arrow keys, Home and End walk it.
 *
 * Always rendered and only ever hidden, so opening and closing are both a transition; a closed one
 * is inert, so neither the keyboard nor a screen reader can reach into it.
 */
export function Menu({
    label,
    open,
    onClose,
    within,
    className,
    onKeyDown,
    children,
    ...rest
}: MenuProps): React.JSX.Element {
    const ref = useRef<HTMLDivElement>(null);
    const close = useEffectEvent(onClose);

    useEffect(() => {
        if (!open) return undefined;
        ref.current?.querySelector<HTMLElement>(ITEMS)?.focus();
        const outside = (event: PointerEvent): void => {
            const boundary = within?.current ?? ref.current;
            if (!boundary?.contains(event.target as Node)) close('outside');
        };
        document.addEventListener('pointerdown', outside);
        return () => document.removeEventListener('pointerdown', outside);
    }, [open, within]);

    function walk(event: KeyboardEvent<HTMLDivElement>): void {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            onClose('escape');
            return;
        }
        if (event.key === 'Tab') {
            onClose('tab');
            return;
        }
        const items = [...(ref.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
        const at = items.indexOf(document.activeElement as HTMLElement);
        const to =
            event.key === 'ArrowDown'
                ? items[(at + 1) % items.length]
                : event.key === 'ArrowUp'
                  ? items[(at - 1 + items.length) % items.length]
                  : event.key === 'Home'
                    ? items[0]
                    : event.key === 'End'
                      ? items.at(-1)
                      : undefined;
        if (to === undefined) return;
        event.preventDefault();
        to.focus();
    }

    return (
        <div
            ref={ref}
            role="menu"
            aria-label={label}
            className={cx('pg-menu', className)}
            data-open={open || undefined}
            inert={!open}
            onKeyDown={walk}
            {...rest}
        >
            {children}
        </div>
    );
}

export type MenuItemProps = Omit<ComponentPropsWithoutRef<'button'>, 'role' | 'type'>;

/** One row of a `Menu` that does something; a row that goes somewhere is a link with `menuItemClass`. */
export function MenuItem({ className, ...rest }: MenuItemProps): React.JSX.Element {
    return <button type="button" role="menuitem" className={menuItemClass(className)} {...rest} />;
}
