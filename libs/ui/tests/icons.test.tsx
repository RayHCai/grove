import { describe, expect, it } from 'vitest';
import { BlocksIcon } from '../src/icons/BlocksIcon.js';
import { ChevronDownIcon } from '../src/icons/ChevronDownIcon.js';
import { ChevronRightIcon } from '../src/icons/ChevronRightIcon.js';
import { CloseIcon } from '../src/icons/CloseIcon.js';
import { CodeIcon } from '../src/icons/CodeIcon.js';
import { FileIcon } from '../src/icons/FileIcon.js';
import { FilesIcon } from '../src/icons/FilesIcon.js';
import { FolderIcon } from '../src/icons/FolderIcon.js';
import { HeartIcon } from '../src/icons/HeartIcon.js';
import { Icon } from '../src/icons/Icon.js';
import { LeafIcon } from '../src/icons/LeafIcon.js';
import { MaximizeIcon } from '../src/icons/MaximizeIcon.js';
import { MinimizeIcon } from '../src/icons/MinimizeIcon.js';
import { MoonIcon } from '../src/icons/MoonIcon.js';
import { PauseIcon } from '../src/icons/PauseIcon.js';
import { PlayIcon } from '../src/icons/PlayIcon.js';
import { PopoutIcon } from '../src/icons/PopoutIcon.js';
import { SendIcon } from '../src/icons/SendIcon.js';
import { SettingsIcon } from '../src/icons/SettingsIcon.js';
import { SparkIcon } from '../src/icons/SparkIcon.js';
import { StarIcon } from '../src/icons/StarIcon.js';
import { StopIcon } from '../src/icons/StopIcon.js';
import { SunIcon } from '../src/icons/SunIcon.js';
import { TerminalIcon } from '../src/icons/TerminalIcon.js';
import { UserIcon } from '../src/icons/UserIcon.js';
import { mount } from './helpers.js';

const icons = [
    ['PlayIcon', PlayIcon],
    ['PauseIcon', PauseIcon],
    ['StopIcon', StopIcon],
    ['SparkIcon', SparkIcon],
    ['UserIcon', UserIcon],
    ['SunIcon', SunIcon],
    ['MoonIcon', MoonIcon],
    ['ChevronDownIcon', ChevronDownIcon],
    ['CodeIcon', CodeIcon],
    ['BlocksIcon', BlocksIcon],
    ['CloseIcon', CloseIcon],
    ['SendIcon', SendIcon],
    ['SettingsIcon', SettingsIcon],
    ['LeafIcon', LeafIcon],
    ['MaximizeIcon', MaximizeIcon],
    ['MinimizeIcon', MinimizeIcon],
    ['PopoutIcon', PopoutIcon],
    ['TerminalIcon', TerminalIcon],
    ['StarIcon', StarIcon],
    ['HeartIcon', HeartIcon],
    ['ChevronRightIcon', ChevronRightIcon],
    ['FileIcon', FileIcon],
    ['FilesIcon', FilesIcon],
    ['FolderIcon', FolderIcon],
] as const;

describe('Icon', () => {
    it('is a hidden 16-unit stroke frame that takes a size and a class', async () => {
        const host = await mount(
            <Icon size={12} className="badge-icon">
                <circle cx="8" cy="8" r="4" />
            </Icon>,
        );
        const svg = host.querySelector('svg');
        expect(svg?.getAttribute('viewBox')).toBe('0 0 16 16');
        expect(svg?.getAttribute('width')).toBe('12');
        expect(svg?.getAttribute('height')).toBe('12');
        expect(svg?.getAttribute('class')).toBe('pg-icon badge-icon');
        expect(svg?.getAttribute('fill')).toBe('none');
        expect(svg?.getAttribute('stroke')).toBe('currentColor');
        expect(svg?.getAttribute('stroke-width')).toBe('1.5');
        expect(svg?.getAttribute('stroke-linecap')).toBe('round');
        expect(svg?.getAttribute('stroke-linejoin')).toBe('round');
        expect(svg?.hasAttribute('shape-rendering')).toBe(false);
        expect(svg?.getAttribute('aria-hidden')).toBe('true');
        expect(svg?.getAttribute('focusable')).toBe('false');
        expect(svg?.querySelector('circle')).not.toBeNull();
    });
});

describe('icons', () => {
    it.each(icons)('%s is a hidden 16px glyph on the 16-unit grid', async (_name, Glyph) => {
        const host = await mount(<Glyph />);
        const svg = host.querySelector('svg');
        expect(svg?.getAttribute('aria-hidden')).toBe('true');
        expect(svg?.getAttribute('focusable')).toBe('false');
        expect(svg?.getAttribute('viewBox')).toBe('0 0 16 16');
        expect(svg?.getAttribute('width')).toBe('16');
        expect(svg?.getAttribute('height')).toBe('16');
        expect(svg?.childElementCount).toBeGreaterThan(0);
    });

    it.each(icons)('%s scales through size while keeping its grid', async (_name, Glyph) => {
        const host = await mount(<Glyph size={12} />);
        const svg = host.querySelector('svg');
        expect(svg?.getAttribute('width')).toBe('12');
        expect(svg?.getAttribute('viewBox')).toBe('0 0 16 16');
    });

    it.each([
        ['PlayIcon', PlayIcon],
        ['PauseIcon', PauseIcon],
        ['StopIcon', StopIcon],
    ] as const)('%s is a filled glyph', async (_name, Glyph) => {
        const host = await mount(<Glyph />);
        for (const shape of host.querySelectorAll('svg > *')) {
            expect(shape.getAttribute('fill')).toBe('currentColor');
            expect(shape.getAttribute('stroke')).toBe('none');
        }
    });
});
