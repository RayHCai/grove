// POLLED, NOT PER FRAME: both callers' reads allocate and neither publishes a change event, so
// sampling on every frame would make the debugger the most expensive thing on screen.

import { useCallback, useEffect, useRef, useState } from 'react';

/** Poll rates offered in the UI, in Hz. `0` freezes — useful for reading a busy tree. */
export const RATES = [0, 2, 4, 10] as const;

/**
 * Samples `read` on an interval, plus once up front, and hands back a way to sample it on demand.
 *
 * `read` is taken through a ref so a fresh closure every render does not re-arm the interval — only
 * `rate` does that. `deps` is for a value `read` closes over that should still trigger an immediate
 * resample when it changes, the way the inspector's bounds toggle does; a caller with nothing like
 * that passes none.
 */
export function usePolled<T>(
    read: () => T,
    rate: number,
    initial: T,
    deps: readonly unknown[] = [],
): { value: T; resample: () => void } {
    const [value, setValue] = useState<T>(initial);
    const readRef = useRef(read);
    readRef.current = read;

    const sample = useCallback(() => setValue(readRef.current()), []);

    useEffect(() => {
        sample();
        if (rate === 0) return;
        const timer = setInterval(sample, 1000 / rate);
        return () => clearInterval(timer);
    }, [rate, sample, ...deps]);

    return { value, resample: sample };
}

export interface RateSelectProps {
    label: string;
    rate: number;
    onChange: (hz: number) => void;
}

/** The `<select>` every poller offers, mapping `RATES` to `frozen` or `{hz}/s`. */
export function RateSelect({ label, rate, onChange }: RateSelectProps): React.JSX.Element {
    return (
        <select aria-label={label} value={rate} onChange={(e) => onChange(Number(e.target.value))}>
            {RATES.map((hz) => (
                <option key={hz} value={hz}>
                    {hz === 0 ? 'frozen' : `${hz}/s`}
                </option>
            ))}
        </select>
    );
}
