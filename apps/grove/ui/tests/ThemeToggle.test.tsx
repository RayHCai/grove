import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { ThemeProvider } from '../src/theme/ThemeProvider.js';
import { ThemeToggle } from '../src/theme/ThemeToggle.js';
import { mount } from './helpers.js';

async function press(button: HTMLButtonElement | null): Promise<void> {
    await act(async () => {
        button?.click();
    });
}

describe('ThemeToggle', () => {
    it('is a ghost pressed-state button named once, with the action in its title', async () => {
        const host = await mount(
            <ThemeProvider>
                <ThemeToggle />
            </ThemeProvider>,
        );
        const button = host.querySelector('button');
        expect(button?.getAttribute('aria-label')).toBe('Dark mode');
        expect(button?.getAttribute('aria-pressed')).toBe('false');
        expect(button?.getAttribute('title')).toBe('Switch to dark mode');
        expect(button?.className).toBe('pg-iconbtn pg-iconbtn--ghost');
        expect(button?.querySelector('svg')).not.toBeNull();
    });

    it('takes another size and variant', async () => {
        const host = await mount(
            <ThemeProvider>
                <ThemeToggle size="sm" variant="secondary" />
            </ThemeProvider>,
        );
        expect(host.querySelector('button')?.className).toBe(
            'pg-iconbtn pg-iconbtn--secondary pg-iconbtn--sm',
        );
    });

    it('flips the theme on the root element and remembers it', async () => {
        const host = await mount(
            <ThemeProvider>
                <ThemeToggle />
            </ThemeProvider>,
        );
        const button = host.querySelector('button');

        await press(button);
        expect(document.documentElement.dataset.theme).toBe('dark');
        expect(button?.getAttribute('aria-pressed')).toBe('true');
        expect(button?.getAttribute('aria-label')).toBe('Dark mode');
        expect(button?.getAttribute('title')).toBe('Switch to light mode');
        expect(localStorage.getItem('grove:theme')).toBe('dark');

        await press(button);
        expect(document.documentElement.dataset.theme).toBe('light');
        expect(button?.getAttribute('aria-pressed')).toBe('false');
        expect(localStorage.getItem('grove:theme')).toBe('light');
    });

    it('lets a caller cancel the flip from its own click handler', async () => {
        const host = await mount(
            <ThemeProvider>
                <ThemeToggle onClick={(event) => event.preventDefault()} />
            </ThemeProvider>,
        );
        await press(host.querySelector('button'));
        expect(document.documentElement.dataset.theme).toBe('light');
    });
});
