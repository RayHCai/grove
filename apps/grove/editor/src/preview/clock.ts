// A page cannot be suspended, but its clock can: while paused, every frame and timer a plain run
// asked for is held and handed over on resume, so a loop stops instead of racing on under Pause.

type Callback = (...fired: unknown[]) => void;

/** Puts the document's frames and timers behind a gate, and answers the handle that shuts it. */
export function gateClocks(scope: Window = window): { pause(): void; resume(): void } {
    let paused = false;
    let held: (() => void)[] = [];

    function gate<T extends (callback: Callback, ...rest: never[]) => number>(schedule: T): T {
        return ((callback: Callback, ...rest: never[]) =>
            schedule(
                (...fired: unknown[]) => {
                    if (paused) held.push(() => callback(...fired));
                    else callback(...fired);
                },
                ...rest,
            )) as T;
    }

    scope.requestAnimationFrame = gate(scope.requestAnimationFrame.bind(scope));
    scope.setTimeout = gate(scope.setTimeout.bind(scope) as never) as never;
    scope.setInterval = gate(scope.setInterval.bind(scope) as never) as never;

    return {
        pause: () => {
            paused = true;
        },
        resume: () => {
            paused = false;
            const waiting = held;
            held = [];
            for (const run of waiting) run();
        },
    };
}
