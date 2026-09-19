import { describe, expect, it } from 'vitest';
import { initialTabs, tabsReducer } from '../src/editor/tabs';

const start = initialTabs('a');

describe('tabsReducer', () => {
    it('opens on one file, active', () => {
        expect(start).toEqual({ open: ['a'], active: 'a' });
    });

    it('appends a file the strip does not hold and selects it', () => {
        expect(tabsReducer(start, { type: 'open', path: 'b' })).toEqual({
            open: ['a', 'b'],
            active: 'b',
        });
    });

    it('selects rather than duplicates a file already open', () => {
        const two = tabsReducer(start, { type: 'open', path: 'b' });
        const again = tabsReducer(two, { type: 'open', path: 'a' });
        expect(again).toEqual({ open: ['a', 'b'], active: 'a' });
    });

    it('ignores a selection of a file that is not open', () => {
        expect(tabsReducer(start, { type: 'select', path: 'zz' })).toBe(start);
    });

    it('drops a closed file and leaves the active one alone', () => {
        const two = tabsReducer(start, { type: 'open', path: 'b' });
        expect(tabsReducer(two, { type: 'close', path: 'a' })).toEqual({
            open: ['b'],
            active: 'b',
        });
    });

    it('falls to the next file when the active one closes', () => {
        const three = ['b', 'c'].reduce(
            (state, path) => tabsReducer(state, { type: 'open', path }),
            start,
        );
        const onB = tabsReducer(three, { type: 'select', path: 'b' });
        expect(tabsReducer(onB, { type: 'close', path: 'b' })).toEqual({
            open: ['a', 'c'],
            active: 'c',
        });
    });

    it('falls back to the previous file when the last one closes', () => {
        const two = tabsReducer(start, { type: 'open', path: 'b' });
        expect(tabsReducer(two, { type: 'close', path: 'b' })).toEqual({
            open: ['a'],
            active: 'a',
        });
    });

    it('leaves nothing active once the strip is empty', () => {
        expect(tabsReducer(start, { type: 'close', path: 'a' })).toEqual({
            open: [],
            active: null,
        });
    });

    it('ignores closing a file that is not open', () => {
        expect(tabsReducer(start, { type: 'close', path: 'zz' })).toBe(start);
    });
});
