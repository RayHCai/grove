import { createElement } from 'react';
import type { ComponentPropsWithRef } from 'react';
import { cx } from '../cx.js';

export type VisuallyHiddenTag = 'span' | 'div' | 'p' | 'h1' | 'h2' | 'h3' | 'label';

export interface VisuallyHiddenProps extends ComponentPropsWithRef<'span'> {
    as?: VisuallyHiddenTag | undefined;
}

/** Text for assistive technology only; it takes no space and never paints. */
export function VisuallyHidden({ as, className, ...rest }: VisuallyHiddenProps): React.JSX.Element {
    return createElement(as ?? 'span', { className: cx('pg-visually-hidden', className), ...rest });
}
