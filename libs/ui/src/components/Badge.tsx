import type { ComponentPropsWithRef } from 'react';
import { cx } from '../cx.js';
import { HeartIcon } from '../icons/HeartIcon.js';
import { LeafIcon } from '../icons/LeafIcon.js';
import { StarIcon } from '../icons/StarIcon.js';

export type BadgeIcon = 'sprout' | 'star' | 'heart';

export interface BadgeProps extends ComponentPropsWithRef<'span'> {
    /** A small icon before the text; it is decorative, so the text must stand on its own. */
    icon?: BadgeIcon | undefined;
}

const glyphs = { sprout: LeafIcon, star: StarIcon, heart: HeartIcon } as const;

/** A pill chip with an optional small icon before its text. */
export function Badge({ icon, className, children, ...rest }: BadgeProps): React.JSX.Element {
    const Glyph = icon === undefined ? undefined : glyphs[icon];
    return (
        <span className={cx('pg-badge', className)} {...rest}>
            {Glyph !== undefined && <Glyph size={12} className="pg-badge__icon" />}
            {children}
        </span>
    );
}
