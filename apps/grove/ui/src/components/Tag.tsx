import type { ComponentPropsWithRef } from 'react';
import { cx } from '../cx.js';

export type TagProps = ComponentPropsWithRef<'span'>;

/** A tiny bordered label in the muted ink, for a category or a mode. */
export function Tag({ className, ...rest }: TagProps): React.JSX.Element {
    return <span className={cx('pg-tag', className)} {...rest} />;
}
