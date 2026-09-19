import { Panel, SectionTitle } from '@grove/ui';
import type { ReactNode } from 'react';

export interface AuthCardProps {
    title: string;
    /** What the service refused, shown above the fields it refused them for. */
    refusal?: string | undefined;
    onSubmit: () => void;
    children: ReactNode;
    /** The line under the card that offers the other way in. */
    footer?: ReactNode | undefined;
}

/** The one card shape every page in the sign-in flow is: a heading, a form, and a way elsewhere. */
export function AuthCard({
    title,
    refusal,
    onSubmit,
    children,
    footer,
}: AuthCardProps): React.JSX.Element {
    return (
        <main className="authpage">
            <Panel
                as="form"
                className="authcard"
                noValidate
                onSubmit={(event) => {
                    // The browser's own navigation would reload the app and lose the typed fields;
                    // everything here is a fetch.
                    event.preventDefault();
                    onSubmit();
                }}
            >
                <SectionTitle as="h1">{title}</SectionTitle>

                {refusal !== undefined && (
                    <p className="authcard__refusal" role="alert">
                        {refusal}
                    </p>
                )}

                <div className="authcard__fields">{children}</div>
            </Panel>
            {footer !== undefined && <p className="authpage__footer">{footer}</p>}
        </main>
    );
}
