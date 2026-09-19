import type { ComponentPropsWithRef, MouseEvent, ReactNode } from 'react';
import { cx } from '../cx.js';
import { isAriaDisabled, swallowClick } from './Button.js';
import { VisuallyHidden } from './VisuallyHidden.js';

export interface ToggleProps extends Omit<
    ComponentPropsWithRef<'button'>,
    'aria-pressed' | 'onChange'
> {
    /** The switch's name; the hidden state word follows it, and the track is decorative. */
    label: ReactNode;
    pressed: boolean;
    /** Called with the state the click asks for; the caller decides whether to take it. */
    onChange?: ((pressed: boolean) => void) | undefined;
    onLabel?: string | undefined;
    offLabel?: string | undefined;
}

/** A switch: the label, then a pill track whose knob slides to the pressed side. */
export function Toggle({
    label,
    pressed,
    onChange,
    onLabel = 'ON',
    offLabel = 'OFF',
    className,
    type = 'button',
    onClick,
    ...rest
}: ToggleProps): React.JSX.Element {
    const inert = isAriaDisabled(rest['aria-disabled']);
    function flip(event: MouseEvent<HTMLButtonElement>): void {
        onClick?.(event);
        if (!event.defaultPrevented) onChange?.(!pressed);
    }
    return (
        <button
            type={type}
            className={cx('pg-toggle', className)}
            aria-pressed={pressed}
            onClick={inert ? swallowClick : flip}
            {...rest}
        >
            <span className="pg-toggle__label">{label}</span>
            <VisuallyHidden className="pg-toggle__state">
                {pressed ? onLabel : offLabel}
            </VisuallyHidden>
            <span className="pg-toggle__track" aria-hidden="true">
                <span className="pg-toggle__knob" />
            </span>
        </button>
    );
}
