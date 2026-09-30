import { act, useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Menu, MenuItem, menuItemClass } from '../src/components/Menu.js';
import type { MenuCloseReason } from '../src/components/Menu.js';
import { mount } from '../src/testing.js';

function key(target: Element | null, name: string): void {
    act(() => {
        target?.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
    });
}

function Harness({ onClose }: { onClose: (reason: MenuCloseReason) => void }): React.JSX.Element {
    const [open, setOpen] = useState(true);
    const root = useRef<HTMLDivElement>(null);
    return (
        <div ref={root}>
            <button type="button" data-trigger onClick={() => setOpen(true)}>
                Account
            </button>
            <Menu
                label="Account"
                open={open}
                within={root}
                onClose={(reason) => {
                    onClose(reason);
                    setOpen(false);
                }}
            >
                <MenuItem>Profile</MenuItem>
                <MenuItem aria-disabled="true">Billing</MenuItem>
                <a href="/games" role="menuitem" className={menuItemClass()}>
                    Games
                </a>
                <MenuItem>Sign out</MenuItem>
            </Menu>
        </div>
    );
}

describe('Menu', () => {
    it('is a named menu that focuses its first item on opening', async () => {
        const host = await mount(<Harness onClose={vi.fn()} />);
        const menu = host.querySelector('[role="menu"]');
        expect(menu?.getAttribute('aria-label')).toBe('Account');
        expect(menu?.hasAttribute('data-open')).toBe(true);
        expect(document.activeElement?.textContent).toBe('Profile');
    });

    it('walks its enabled items with the arrow keys, Home and End, and wraps', async () => {
        const host = await mount(<Harness onClose={vi.fn()} />);
        const menu = host.querySelector('[role="menu"]');
        key(menu, 'ArrowDown');
        expect(document.activeElement?.textContent).toBe('Games');
        key(menu, 'End');
        expect(document.activeElement?.textContent).toBe('Sign out');
        key(menu, 'ArrowDown');
        expect(document.activeElement?.textContent).toBe('Profile');
        key(menu, 'ArrowUp');
        expect(document.activeElement?.textContent).toBe('Sign out');
        key(menu, 'Home');
        expect(document.activeElement?.textContent).toBe('Profile');
    });

    it('closes on Escape and turns inert once closed', async () => {
        const onClose = vi.fn();
        const host = await mount(<Harness onClose={onClose} />);
        const menu = host.querySelector('[role="menu"]');
        key(menu, 'Escape');
        expect(onClose).toHaveBeenCalledWith('escape');
        expect(menu?.hasAttribute('data-open')).toBe(false);
        expect(menu?.hasAttribute('inert')).toBe(true);
    });

    it('closes on a press outside its boundary but not on one inside it', async () => {
        const onClose = vi.fn();
        const host = await mount(<Harness onClose={onClose} />);
        act(() => {
            host.querySelector('[data-trigger]')?.dispatchEvent(
                new PointerEvent('pointerdown', { bubbles: true }),
            );
        });
        expect(onClose).not.toHaveBeenCalled();
        act(() => {
            document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        });
        expect(onClose).toHaveBeenCalledWith('outside');
    });
});
