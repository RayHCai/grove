import { SectionTitle } from '@grove/ui';
import type { ReactNode } from 'react';
import { FormPanel } from '../chrome/FormPanel';

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
            <FormPanel className="authcard" onSubmit={onSubmit}>
                <SectionTitle as="h1" className="authcard__title">
                    {title}
                </SectionTitle>

                {refusal !== undefined && (
                    <p className="authcard__refusal" role="alert">
                        {refusal}
                    </p>
                )}

                <div className="authcard__fields">{children}</div>
            </FormPanel>
            {footer !== undefined && <p className="authpage__footer">{footer}</p>}
        </main>
    );
}
