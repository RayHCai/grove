import { createElement } from 'react';
import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from '../cx.js';

export type SectionTitleTag = 'h1' | 'h2' | 'h3';
export type SectionTitleVariant = 'plate' | 'label';

export interface SectionTitleProps extends ComponentPropsWithRef<'h2'> {
    as?: SectionTitleTag | undefined;
    /** `plate` inks the heading onto a title plate; `label` is a muted caps line for a dense rail. */
    variant?: SectionTitleVariant | undefined;
    /** Muted copy after the heading, kept outside it so the heading's name stays the title. */
    subline?: ReactNode | undefined;
}

/** A section's heading and its optional muted subline. */
export function SectionTitle({
    as,
    variant = 'plate',
    subline,
    className,
    ...rest
}: SectionTitleProps): React.JSX.Element {
    return (
        <>
            {createElement(as ?? 'h2', {
                className: cx(
                    'pg-sectitle',
                    variant === 'label' && 'pg-sectitle--label',
                    className,
                ),
                ...rest,
            })}
            {subline !== undefined && subline !== null && (
                <p className="pg-sectitle__sub">{subline}</p>
            )}
        </>
    );
}
