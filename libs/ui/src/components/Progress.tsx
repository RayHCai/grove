import { useId } from 'react';
import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from '../cx.js';

export interface ProgressProps extends Omit<ComponentPropsWithRef<'div'>, 'children'> {
    /** Names the bar; it is what the progressbar is labelled by. */
    label: ReactNode;
    value: number;
    max?: number | undefined;
}

/** A labelled progress bar: a pill track whose accent fill scales from the left to the value. */
export function Progress({
    label,
    value,
    max = 100,
    className,
    ...rest
}: ProgressProps): React.JSX.Element {
    const labelId = useId();
    const ceiling = Math.max(max, 0);
    const now = Math.min(Math.max(value, 0), ceiling);
    const ratio = ceiling > 0 ? now / ceiling : 0;
    return (
        <div className={cx('pg-progress', className)} {...rest}>
            <div className="pg-progress__head">
                <span className="pg-progress__label" id={labelId}>
                    {label}
                </span>
                <span className="pg-progress__value">{Math.round(ratio * 100)}%</span>
            </div>
            <div
                className="pg-progress__bar"
                role="progressbar"
                aria-labelledby={labelId}
                aria-valuemin={0}
                aria-valuemax={ceiling}
                aria-valuenow={now}
            >
                <div className="pg-progress__fill" style={{ transform: `scaleX(${ratio})` }} />
            </div>
        </div>
    );
}
