import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SparkIcon } from '@grove/ui';
import { AiPanel } from '../src/shell/AiPanel';
import { mount } from './helpers';

function escape(target: Element | null | undefined, prevented = false): void {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    if (prevented) event.preventDefault();
    target?.dispatchEvent(event);
}

describe('AiPanel', () => {
    it('is the aside the rail controls, hidden and focusable by script', async () => {
        const host = await mount(<AiPanel open={false} onClose={vi.fn()} />);
        const aside = host.querySelector<HTMLElement>('aside');
        expect(aside?.id).toBe('grove-ai-panel');
        expect(aside?.getAttribute('aria-label')).toBe('Grove AI');
        expect(aside?.tabIndex).toBe(-1);
        expect(aside?.hidden).toBe(true);
        expect(aside?.getAttribute('data-open')).toBe('false');
    });

    it('shows when open, headed by the spark mark, the title and a ghost close button', async () => {
        const host = await mount(<AiPanel open onClose={vi.fn()} />);
        const aside = host.querySelector<HTMLElement>('aside');
        expect(aside?.hidden).toBe(false);
        expect(aside?.getAttribute('data-open')).toBe('true');
        const head = aside?.querySelector('.side-panel__head');
        expect(head?.children.length).toBe(3);
        const mark = head?.firstElementChild;
        expect(mark?.className).toBe('ai-panel__mark');
        const reference = await mount(<SparkIcon />);
        expect(mark?.querySelector('svg')?.outerHTML).toBe(
            reference.querySelector('svg')?.outerHTML,
        );
        expect(head?.querySelector('h2')?.textContent).toBe('Grove AI');
        expect(head?.querySelector('h2')?.className).toBe('side-panel__title');
        expect(head?.querySelector('[aria-label="Close"]')?.className).toBe(
            'pg-iconbtn pg-iconbtn--ghost pg-iconbtn--sm',
        );
    });

    it('opens the thread on an accent note', async () => {
        const host = await mount(<AiPanel open onClose={vi.fn()} />);
        const note = host.querySelector('.ai-panel__thread > .ai-panel__note');
        expect(note?.className).toBe('pg-panel pg-panel--accent ai-panel__note');
        expect(note?.textContent).toBe('I’ll help you grow your game. Chat is coming soon.');
    });

    it('composer is readOnly and described by the status line', async () => {
        const host = await mount(<AiPanel open onClose={vi.fn()} />);
        const textarea = host.querySelector<HTMLTextAreaElement>('textarea');
        expect(textarea?.readOnly).toBe(true);
        expect(textarea?.disabled).toBe(false);
        expect(textarea?.placeholder).toBe('Chat is coming soon');
        expect(textarea?.getAttribute('aria-describedby')).toBe('ai-status');
        expect(host.querySelector('#ai-status')?.textContent).toBe('Grove AI · not connected yet');
        const label = host.querySelector(`label[for="${textarea?.id}"]`);
        expect(label?.textContent).toBe('Message Grove AI');
        expect(label?.className).toBe('pg-visually-hidden');
    });

    it('keeps Send focusable but inert, described by the same status', async () => {
        const host = await mount(<AiPanel open onClose={vi.fn()} />);
        const send = host.querySelector<HTMLButtonElement>('[aria-label="Send"]');
        expect(send?.className).toBe('pg-iconbtn pg-iconbtn--primary pg-iconbtn--sm');
        expect(send?.getAttribute('aria-disabled')).toBe('true');
        expect(send?.disabled).toBe(false);
        expect(send?.getAttribute('aria-describedby')).toBe('ai-status');
    });

    it('asks to close from the close button and from Escape inside it', async () => {
        const onClose = vi.fn();
        const host = await mount(<AiPanel open onClose={onClose} />);
        await act(async () => {
            host.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click();
        });
        expect(onClose).toHaveBeenCalledTimes(1);
        await act(async () => {
            escape(host.querySelector('textarea'));
        });
        expect(onClose).toHaveBeenCalledTimes(2);
    });

    it('leaves an Escape that something inside already handled alone', async () => {
        const onClose = vi.fn();
        const host = await mount(<AiPanel open onClose={onClose} />);
        await act(async () => {
            escape(host.querySelector('textarea'), true);
        });
        expect(onClose).not.toHaveBeenCalled();
    });
});
