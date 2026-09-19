import { describe, expect, it } from 'vitest';
import { cx } from '../src/cx.js';

describe('cx', () => {
    it('joins the names that are set and drops the rest', () => {
        expect(cx('pg-btn', false, null, undefined, '', 'pg-btn--sm')).toBe('pg-btn pg-btn--sm');
    });

    it('is empty when nothing is set', () => {
        expect(cx(false, undefined)).toBe('');
    });
});
