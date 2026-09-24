import { createElement } from 'react';
import type { ComponentPropsWithRef } from 'react';
import { cx } from '../cx.js';

export type PanelFace = 'surface' | 'accent' | 'olive' | 'warm';
export type PanelTag = 'div' | 'section' | 'aside' | 'article' | 'form' | 'figure';

/**
 * A panel's own two props, over every attribute the element it renders as accepts.
 *
 * Parameterised by the tag rather than fixed to a `div`: `as="form"` is one of the six above, and a
 * form that could not be given an `onSubmit` or a `noValidate` is a tag this component only claimed
 * to support.
 */
export type PanelProps<T extends PanelTag = 'div'> = {
    as?: T | undefined;
    face?: PanelFace | undefined;
    className?: string | undefined;
} & Omit<ComponentPropsWithRef<T>, 'as' | 'className'>;

/** A pane or card: a surface with a 1px border, 12px corners and a soft shadow, in one of four faces. */
export function Panel<T extends PanelTag = 'div'>({
    as,
    face = 'surface',
    className,
    ...rest
}: PanelProps<T>): React.JSX.Element {
    return createElement(as ?? 'div', {
        className: cx('pg-panel', `pg-panel--${face}`, className),
        ...rest,
    });
}
