import { Component } from 'react';
import type { ReactNode } from 'react';
import { Button } from './Button.js';
import { Panel } from './Panel.js';

export interface ErrorBoundaryProps {
    children: ReactNode;
    /** Runs once when the tree below throws, as the recovery view replaces it. */
    onError?: ((error: unknown) => void) | undefined;
    /** How the page is started again; a test hands in its own rather than reloading. */
    reload?: (() => void) | undefined;
}

interface ErrorBoundaryState {
    failed: boolean;
}

/**
 * The root every app mounts under, so a render that throws leaves a way back instead of a blank page.
 *
 * A class because React still offers no hook for catching a render error.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    override state: ErrorBoundaryState = { failed: false };

    static getDerivedStateFromError(): ErrorBoundaryState {
        return { failed: true };
    }

    override componentDidCatch(error: unknown): void {
        this.props.onError?.(error);
    }

    override render(): ReactNode {
        if (!this.state.failed) return this.props.children;
        const reload = this.props.reload ?? (() => globalThis.location.reload());
        return (
            <main className="pg-crash">
                <Panel className="pg-crash__card">
                    <p role="alert">Something on this page broke. Reloading it starts it again.</p>
                    <Button variant="primary" onClick={reload}>
                        Reload
                    </Button>
                </Panel>
            </main>
        );
    }
}
