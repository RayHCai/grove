import type { ComponentPropsWithRef } from 'react';
import { hrefOf, type Route } from './routes';
import { go } from './useRoute';

export interface LinkProps extends Omit<ComponentPropsWithRef<'a'>, 'href'> {
    to: Route;
}

/**
 * A real anchor that navigates in place.
 *
 * `href` is set as well as handled, so the link can be middle-clicked, copied and read by anything
 * that looks at a page's links — a span with an `onClick` is none of those things.
 */
export function Link({ to, onClick, ...rest }: LinkProps): React.JSX.Element {
    return (
        <a
            href={hrefOf(to)}
            onClick={(event) => {
                onClick?.(event);
                if (event.defaultPrevented) return;
                // A modifier or any button but the first means another tab or window, which is the
                // browser's to open rather than this app's to swallow.
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                if (event.button !== 0) return;
                event.preventDefault();
                go(to);
            }}
            {...rest}
        />
    );
}
