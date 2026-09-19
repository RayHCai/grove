import { Button, Eyebrow, Panel, SectionTitle } from '@grove/ui';
import { go } from '../router/useRoute';

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
                <Button variant="primary" onClick={() => go({ at: 'landing' })}>
                    Back to the front
                </Button>
            </Panel>
        </main>
    );
}
