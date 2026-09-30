import { Panel } from '@grove/ui';
import type { PanelProps } from '@grove/ui';

export type FormPanelProps = Omit<PanelProps<'form'>, 'as' | 'onSubmit' | 'noValidate'> & {
    onSubmit: () => void;
};

/**
 * A panel that is a form, submitted by fetch.
 *
 * The browser's own submit would reload the app and lose the typed fields, and its own validation
 * speaks in the browser's words, so both are off: every form here checks and says things itself.
 */
export function FormPanel({ onSubmit, ...rest }: FormPanelProps): React.JSX.Element {
    return (
        <Panel
            as="form"
            noValidate
            onSubmit={(event) => {
                event.preventDefault();
                onSubmit();
            }}
            {...rest}
        />
    );
}
