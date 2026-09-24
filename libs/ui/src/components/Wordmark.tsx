import { createElement } from 'react';
import type { ComponentPropsWithRef } from 'react';
import { cx } from '../cx.js';
import { LeafIcon } from '../icons/LeafIcon.js';

export interface WordmarkProps extends ComponentPropsWithRef<'a'> {
    /** Where the wordmark links to; without one it is a plain span. */
    href?: string | undefined;
}

/** The moss leaf and the name, "Grove" unless children say otherwise. */
export function Wordmark({ href, className, children, ...rest }: WordmarkProps): React.JSX.Element {
    return createElement(
        href === undefined ? 'span' : 'a',
        { className: cx('pg-wordmark', className), href, ...rest },
        <span className="pg-wordmark__leaf" aria-hidden="true">
            <LeafIcon />
        </span>,
        children ?? 'Grove',
    );
}
