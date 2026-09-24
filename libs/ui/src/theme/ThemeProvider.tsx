import {
    createContext,
    useCallback,
    useContext,
    useLayoutEffect,
    useMemo,
    useState,
    useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';

export type Theme = 'light' | 'dark';
export type ThemePreference = Theme | 'system';

export interface ThemeContextValue {
    /** The theme actually applied to `<html data-theme>`. */
    theme: Theme;
    /** What the viewer chose; `system` follows the OS. */
    preference: ThemePreference;
    setPreference: (preference: ThemePreference) => void;
}

export interface ThemeProviderProps {
    children: ReactNode;
}

const STORAGE_KEY = 'grove:theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

const ThemeContext = createContext<ThemeContextValue | null>(null);

function isThemePreference(value: unknown): value is ThemePreference {
    return value === 'light' || value === 'dark' || value === 'system';
}

function readPreference(): ThemePreference {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        return isThemePreference(stored) ? stored : 'system';
    } catch {
        return 'system';
    }
}

function writePreference(preference: ThemePreference): void {
    try {
        localStorage.setItem(STORAGE_KEY, preference);
    } catch {
        // Private windows and sandboxed frames refuse storage; the choice then lasts the session.
    }
}

function subscribeSystem(onChange: () => void): () => void {
    if (typeof window.matchMedia !== 'function') return () => undefined;
    const query = window.matchMedia(DARK_QUERY);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
}

function systemIsDark(): boolean {
    return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;
}

/** Owns `data-theme` on `<html>` and the `grove:theme` preference behind it. */
export function ThemeProvider({ children }: ThemeProviderProps): React.JSX.Element {
    const [preference, setPreferenceState] = useState<ThemePreference>(readPreference);
    const systemDark = useSyncExternalStore(subscribeSystem, systemIsDark);
    const theme: Theme = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;

    useLayoutEffect(() => {
        document.documentElement.dataset.theme = theme;
    }, [theme]);

    const setPreference = useCallback((next: ThemePreference) => {
        writePreference(next);
        setPreferenceState(next);
    }, []);

    const value = useMemo(
        () => ({ theme, preference, setPreference }),
        [theme, preference, setPreference],
    );

    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** The current theme and its setter; only valid under a `ThemeProvider`. */
export function useTheme(): ThemeContextValue {
    const value = useContext(ThemeContext);
    if (value === null) throw new Error('useTheme must be called inside a ThemeProvider');
    return value;
}
