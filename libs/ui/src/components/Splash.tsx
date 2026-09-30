import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { cx } from '../cx.js';
import { Panel } from './Panel.js';
import { Wordmark } from './Wordmark.js';

export interface SplashProps extends Omit<ComponentPropsWithoutRef<'main'>, 'children'> {
    /** Whether the page is still working something out, which is what `aria-busy` reports. */
    busy?: boolean | undefined;
    /** A line of progress, read as a status. */
    note?: ReactNode | undefined;
    /** A line of failure, read as an alert. */
    alert?: ReactNode | undefined;
    /** Anything after the lines: a progress bar, a way to try again. */
    children?: ReactNode;
}

/** The whole page while an app has nothing else to show: the wordmark on a card, and a line or two. */
export function Splash({
    busy = false,
    note,
    alert,
    className,
    children,
    ...rest
}: SplashProps): React.JSX.Element {
    return (
        <main className={cx('pg-splash', className)} {...rest}>
            <Panel className="pg-splash__card" aria-busy={busy || undefined}>
                <Wordmark />
                {note !== undefined && (
                    <p className="pg-splash__note" role="status">
                        {note}
                    </p>
                )}
                {alert !== undefined && (
                    <p className="pg-splash__alert" role="alert">
                        {alert}
                    </p>
                )}
                {children}
            </Panel>
        </main>
    );
}
