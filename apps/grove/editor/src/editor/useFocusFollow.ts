import { useCallback, useEffect, useEffectEvent, useRef } from 'react';

/**
 * Moves focus onto what `find` names once `key` changes, but only after a keyboard move asked.
 *
 * Returns the asking: a widget calls it from the keys that move its selection, so focus follows
 * the keyboard and a click never pulls focus back off the pointer.
 */
export function useFocusFollow(
    key: unknown,
    find: () => HTMLElement | null | undefined,
): () => void {
    const asked = useRef(false);
    const target = useEffectEvent(find);

    useEffect(() => {
        if (!asked.current) return;
        asked.current = false;
        target()?.focus();
    }, [key]);

    return useCallback(() => {
        asked.current = true;
    }, []);
}
