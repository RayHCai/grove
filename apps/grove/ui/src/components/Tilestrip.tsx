import type { ComponentPropsWithRef } from 'react';
import { cx } from '../cx.js';

export type TilestripProps = Omit<ComponentPropsWithRef<'div'>, 'aria-hidden' | 'children'>;

/** The 4px brand strip across the very top of a page; decorative, so hidden from assistive technology. */
export function Tilestrip({ className, ...rest }: TilestripProps): React.JSX.Element {
    return <div className={cx('pg-tilestrip', className)} aria-hidden="true" {...rest} />;
}
