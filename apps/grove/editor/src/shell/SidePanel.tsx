import type { KeyboardEvent, ReactNode, Ref } from 'react';
import { CloseIcon, IconButton, cx } from '@grove/ui';

export interface SidePanelProps {
    /** The id the rail's button controls. */
    id: string;
    label: string;
    title: string;
    className: string;
    open: boolean;
    /** Runs on the close button and on Escape inside the panel; the caller returns focus. */
    onClose: () => void;
    /** Offered Escape first; answering `true` means something inside took it and the panel stays. */
    onEscape?: (() => boolean) | undefined;
    /** Drawn before the title. */
    mark?: ReactNode | undefined;
    ref?: Ref<HTMLElement> | undefined;
    children: ReactNode;
}

/** A panel the side rail opens: kept mounted and hidden while closed, so what is typed in it stays. */
export function SidePanel({
    id,
    label,
    title,
    className,
    open,
    onClose,
    onEscape,
    mark,
    ref,
    children,
}: SidePanelProps): React.JSX.Element {
    function closeOnEscape(event: KeyboardEvent<HTMLElement>): void {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        if (onEscape?.() === true) return;
        onClose();
    }

    return (
        <aside
            id={id}
            aria-label={label}
            className={cx('side-panel', className)}
            ref={ref}
            tabIndex={-1}
            hidden={!open}
            data-open={open}
            onKeyDown={closeOnEscape}
        >
            <div className="side-panel__head">
                {mark}
                <h2 className="side-panel__title">{title}</h2>
                <IconButton label="Close" variant="ghost" size="sm" onClick={onClose}>
                    <CloseIcon />
                </IconButton>
            </div>
            {children}
        </aside>
    );
}
