import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@grove/ui';
import { CodeEditor } from '../src/editor/CodeEditor';
import { mount, untilSettled } from './helpers';

// The setup file resolves the boundary for every other test; here the chunk never arrives.
vi.mock('../src/editor/monaco', () => Promise.reject(new Error('the chunk is gone')));

describe('CodeEditor when the boundary fails to load', () => {
    it('drops the busy state and says so in an alert inside the body', async () => {
        const host = await mount(
            <StrictMode>
                <ThemeProvider>
                    <CodeEditor
                        file={{
                            path: 'src/main.ts',
                            name: 'main.ts',
                            language: 'typescript',
                            value: 'let x = 1;',
                        }}
                    />
                </ThemeProvider>
            </StrictMode>,
        );
        await untilSettled(host);

        const region = host.querySelector('[role="region"]');
        expect(region?.className).toBe('editor-body');
        expect(region?.getAttribute('aria-busy')).toBe('false');
        expect(host.querySelector('[role="status"]')).toBeNull();
        const alert = host.querySelector('[role="alert"]');
        expect(alert?.parentElement).toBe(region);
        expect(alert?.textContent).toBe('The editor could not load. Reload the page to try again.');
        expect(alert?.className).toBe('editor-status');
    });
});
