import { createElement } from 'react';
import type { ComponentPropsWithRef } from 'react';
import { cx } from '../cx.js';

export type EyebrowTag = 'p' | 'span';

export interface EyebrowProps extends ComponentPropsWithRef<'p'> {
    as?: EyebrowTag | undefined;
}

/** The warm kicker above a title, with a round dot before its text. */
export function Eyebrow({ as, className, ...rest }: EyebrowProps): React.JSX.Element {
    return createElement(as ?? 'p', { className: cx('pg-eyebrow', className), ...rest });
}
