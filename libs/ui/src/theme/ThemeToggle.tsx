import type { ComponentPropsWithRef } from 'react';
import { IconButton } from '../components/IconButton.js';
import type { IconButtonSize, IconButtonVariant } from '../components/IconButton.js';
import { MoonIcon } from '../icons/MoonIcon.js';
import { SunIcon } from '../icons/SunIcon.js';
import { useTheme } from './ThemeProvider.js';

export interface ThemeToggleProps extends Omit<
    ComponentPropsWithRef<'button'>,
    'aria-label' | 'aria-pressed' | 'children'
> {
    size?: IconButtonSize | undefined;
    variant?: IconButtonVariant | undefined;
}

/** A pressed-state toolbar button that flips the theme between light and dark explicitly. */
export function ThemeToggle({
    size = 'md',
    variant = 'ghost',
    title,
    onClick,
    ...rest
}: ThemeToggleProps): React.JSX.Element {
    const { theme, setPreference } = useTheme();
    const dark = theme === 'dark';
    return (
        <IconButton
            label="Dark mode"
            title={title ?? (dark ? 'Switch to light mode' : 'Switch to dark mode')}
            pressed={dark}
            size={size}
            variant={variant}
            onClick={(event) => {
                onClick?.(event);
                if (!event.defaultPrevented) setPreference(dark ? 'light' : 'dark');
            }}
            {...rest}
        >
            {dark ? <MoonIcon /> : <SunIcon />}
        </IconButton>
    );
}
