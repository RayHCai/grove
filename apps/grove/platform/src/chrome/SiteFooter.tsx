import { Panel, Wordmark } from '@grove/ui';

/** The footer every page carries. */
export function SiteFooter(): React.JSX.Element {
    return (
        <footer className="sitefooter">
            <Panel face="olive" className="sitefooter__inner">
                <Wordmark />
            </Panel>
        </footer>
    );
}
