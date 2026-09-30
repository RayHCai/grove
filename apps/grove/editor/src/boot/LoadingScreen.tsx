import { Progress, Splash } from '@grove/ui';

/** The steps a first load walks, in order, so the bar reports a place rather than a spinner. */
export const STEPS = ['session', 'account', 'game', 'files'] as const;
export type Step = (typeof STEPS)[number];

const WORDING: Record<Step, string> = {
    session: 'Checking your session',
    account: 'Reading your account',
    game: 'Finding your game',
    files: 'Loading your files',
};

export interface LoadingScreenProps {
    step: Step;
}

/** What the editor shows while it works out who is editing, what, and what is in it. */
export function LoadingScreen({ step }: LoadingScreenProps): React.JSX.Element {
    return (
        <Splash busy className="boot">
            <Progress label={WORDING[step]} value={STEPS.indexOf(step) + 1} max={STEPS.length} />
        </Splash>
    );
}
