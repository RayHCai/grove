const compact = new Intl.NumberFormat('en', { notation: 'compact' });

/** What a game page shows for a count nobody keeps. */
export const UNCOUNTED = '—';

/** A count the way a game page shows it: short, or a dash where nothing counts it. */
export function formatCount(value: number | undefined): string {
    return value === undefined ? UNCOUNTED : compact.format(value);
}
