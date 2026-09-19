import { act, createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { IconButton } from '../src/components/IconButton.js';
import { StopIcon } from '../src/icons/StopIcon.js';
import { mount } from './helpers.js';

describe('IconButton', () => {
    it('is named and titled by its label and holds one icon', async () => {
        const host = await mount(
            <IconButton label="Stop">
                <StopIcon />
            </IconButton>,
        );
        const button = host.querySelector('button');
        expect(button?.getAttribute('type')).toBe('button');
        expect(button?.getAttribute('aria-label')).toBe('Stop');
        expect(button?.getAttribute('title')).toBe('Stop');
        expect(button?.hasAttribute('aria-pressed')).toBe(false);
        expect(button?.className).toBe('pg-iconbtn pg-iconbtn--secondary');
        expect(button?.querySelectorAll('svg').length).toBe(1);
        expect(button?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    });

    it('lets a title of its own replace the label as the tooltip', async () => {
        const host = await mount(
            <IconButton label="Profile" title="Profiles are coming soon">
                <StopIcon />
            </IconButton>,
        );
        expect(host.querySelector('button')?.getAttribute('title')).toBe(
            'Profiles are coming soon',
        );
    });

    it('exposes pressed as aria-pressed and takes the small size and a variant', async () => {
        const host = await mount(
            <IconButton label="Grove AI" pressed size="sm" variant="primary">
                <StopIcon />
            </IconButton>,
        );
        const button = host.querySelector('button');
        expect(button?.getAttribute('aria-pressed')).toBe('true');
        expect(button?.className).toBe('pg-iconbtn pg-iconbtn--primary pg-iconbtn--sm');
    });

    it('has a ghost variant for toolbars', async () => {
        const host = await mount(
            <IconButton label="Close" variant="ghost">
                <StopIcon />
            </IconButton>,
        );
        expect(host.querySelector('button')?.className).toBe('pg-iconbtn pg-iconbtn--ghost');
    });

    it('passes the ref and native attributes through', async () => {
        const ref = createRef<HTMLButtonElement>();
        const host = await mount(
            <IconButton label="Grove AI" ref={ref} aria-expanded aria-controls="grove-ai-panel">
                <StopIcon />
            </IconButton>,
        );
        const button = host.querySelector('button');
        expect(ref.current).toBe(button);
        expect(button?.getAttribute('aria-expanded')).toBe('true');
        expect(button?.getAttribute('aria-controls')).toBe('grove-ai-panel');
    });

    it('keeps an aria-disabled button focusable but swallows its clicks', async () => {
        const onClick = vi.fn();
        const host = await mount(
            <IconButton label="Send" aria-disabled="true" onClick={onClick}>
                <StopIcon />
            </IconButton>,
        );
        const button = host.querySelector('button');
        expect(button?.disabled).toBe(false);
        await act(async () => {
            button?.click();
        });
        expect(onClick).not.toHaveBeenCalled();
    });
});
