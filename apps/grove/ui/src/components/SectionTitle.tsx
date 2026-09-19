import { createElement } from 'react';
import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from '../cx.js';

export type SectionTitleTag = 'h1' | 'h2' | 'h3';

export interface SectionTitleProps extends ComponentPropsWithRef<'h2'> {
    as?: SectionTitleTag | undefined;
    /** Muted copy after the heading, kept outside it so the heading's name stays the title. */
    subline?: ReactNode | undefined;
}

/** A section's heading and its optional muted subline. */
export function SectionTitle({
    as,
    subline,
    className,
    ...rest
}: SectionTitleProps): React.JSX.Element {
    return (
        <>
            {createElement(as ?? 'h2', { className: cx('pg-sectitle', className), ...rest })}
            {subline !== undefined && subline !== null && (
                <p className="pg-sectitle__sub">{subline}</p>
            )}
        </>
    );
}
