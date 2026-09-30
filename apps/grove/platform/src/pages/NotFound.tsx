import { Eyebrow, Panel, SectionTitle } from '@grove/ui';
import { ButtonLink } from '../router/Link';

export interface NotFoundProps {
    path: string;
}

/** An address this origin has no page for. */
export function NotFound({ path }: NotFoundProps): React.JSX.Element {
    return (
        <main className="zone">
            <Panel className="zone__empty">
                <Eyebrow>Nothing here</Eyebrow>
                <SectionTitle as="h1" subline={`Grove has no page at ${path}.`}>
                    Lost in the trees
                </SectionTitle>
                <ButtonLink variant="primary" to={{ at: 'landing' }}>
                    Back to the front
                </ButtonLink>
            </Panel>
        </main>
    );
}
