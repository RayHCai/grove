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

/** The 16x16 filled frame every icon draws into, with crisp edges so a cell stays a square. */
export function Icon({ size = 16, className, children }: IconFrameProps): React.JSX.Element {
    return (
        <svg
            className={cx('pg-icon', className)}
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="currentColor"
            shapeRendering="crispEdges"
            aria-hidden="true"
            focusable="false"
        >
            {children}
        </svg>
    );
}

/** The cell an 8-row sprite paints, in frame units. */
const CELL = 2;

/**
 * One path for an 8-row sprite, `#` a filled cell and `.` an empty one: every icon is a two-unit
 * pixel drawing, the same weight as the 3px edge and 4px lift around it.
 */
export function sprite(rows: readonly string[]): string {
    let d = '';
    rows.forEach((row, y) => {
        for (let x = 0; x < row.length; x += 1) {
            if (row[x] !== '#') continue;
            d += `M${x * CELL} ${y * CELL}h${CELL}v${CELL}h-${CELL}z`;
        }
    });
    return d;
}

export interface SpriteIconProps extends IconProps {
    rows: readonly string[];
}

/** An icon drawn from an 8-row sprite. */
export function SpriteIcon({ rows, ...props }: SpriteIconProps): React.JSX.Element {
    return (
        <Icon {...props}>
            <path d={sprite(rows)} />
        </Icon>
    );
}
