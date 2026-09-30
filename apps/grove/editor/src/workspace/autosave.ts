import { createContext, useContext, useEffect, useEffectEvent } from 'react';
import { isPending, type Pending } from './files';

/** How long after the last keystroke a save goes. Long enough not to save mid-word. */
export const SAVE_DEBOUNCE_MS = 1_500;

/**
 * The longest anything stays unsaved while somebody keeps typing.
 *
 * Without a ceiling, a creator who never pauses long enough for the debounce has an hour of work
 * held in one tab, and the debounce is exactly the wrong thing to shorten, because shortening it
 * saves mid-word.
 */
export const SAVE_CEILING_MS = 30_000;

export interface AutosaveOptions {
    /** What the editor still owes the service; a new object per edit is what restarts the clock. */
    pending: Pending;
    /** An ordinary save. Failures are the caller's to report; this hook never reports one. */
    save: () => void;
    /**
     * The one save a closing or hidden tab gets.
     *
     * Synchronous by construction: it fires a `keepalive` request and returns. An `await` here
     * would be an await the browser has already stopped running.
     */
    flush: () => void;
}

/**
 * Saves without being asked: after a pause, at a ceiling, and when the tab goes away.
 *
 * Three triggers because no one of them covers the others. The debounce is the ordinary case; the
 * ceiling is the creator who never pauses; the hidden tab is the one that never comes back. The
 * autosave is what actually protects work; the exit dialog is only the backstop.
 */
export function useAutosave({ pending, save, flush }: AutosaveOptions): void {
    // Effect events, so the listeners below are registered once rather than re-registered on
    // every keystroke, which on `beforeunload` is the difference between one handler and hundreds.
    const saveNow = useEffectEvent(save);
    const flushIfOwed = useEffectEvent((): boolean => {
        if (!isPending(pending)) return false;
        flush();
        return true;
    });

    useEffect(() => {
        if (!isPending(pending)) return;
        const debounce = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
        return () => clearTimeout(debounce);
    }, [pending]);

    // Anchored on becoming dirty rather than on each edit, so typing without pause still lands a
    // save every ceiling instead of pushing the deadline forward forever.
    const wasPending = isPending(pending);
    useEffect(() => {
        if (!wasPending) return;
        const ceiling = setTimeout(saveNow, SAVE_CEILING_MS);
        return () => clearTimeout(ceiling);
    }, [wasPending]);

    useEffect(() => {
        const onHidden = (): void => {
            if (document.visibilityState === 'hidden') flushIfOwed();
        };
        // `visibilitychange` and not `pagehide`: a phone switching apps fires this one, and it is
        // the last event a tab is guaranteed to get.
        document.addEventListener('visibilitychange', onHidden);

        const onUnload = (event: BeforeUnloadEvent): void => {
            if (!flushIfOwed()) return;
            // The browser shows its own wording and ignores anything set here; what matters is
            // that the event is cancelled at all.
            event.preventDefault();
        };
        window.addEventListener('beforeunload', onUnload);

        return () => {
            document.removeEventListener('visibilitychange', onHidden);
            window.removeEventListener('beforeunload', onUnload);
        };
    }, []);
}

/**
 * Where the workbench leaves its exit save for the root error boundary to fire.
 *
 * A render that throws unmounts the workbench and everything it held, so the boundary is the last
 * thing that can still send what was typed; the slot holds `undefined` while nothing is unsaved.
 */
export const CrashFlush = createContext<{ current: (() => void) | undefined }>({
    current: undefined,
});

/** Keeps the crash slot pointing at this render's exit save, or at nothing when there is none. */
export function useCrashFlush(flush: (() => void) | undefined): void {
    const slot = useContext(CrashFlush);
    useEffect(() => {
        slot.current = flush;
    });
}
