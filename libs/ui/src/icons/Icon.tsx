import type { ReactNode } from 'react';
import { cx } from '../cx.js';

export interface IconProps {
    /** Rendered width and height in pixels; the drawing stays on its 16-unit grid. */
    size?: number | undefined;
    className?: string | undefined;
}

export interface IconFrameProps extends IconProps {
    children: ReactNode;
}

/** The 16x16 stroke frame every icon draws into; a filled glyph overrides fill and stroke on its own shapes. */
export function Icon({ size = 16, className, children }: IconFrameProps): React.JSX.Element {
    return (
        <svg
            className={cx('pg-icon', className)}
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
        >
            {children}
        </svg>
    );
}
