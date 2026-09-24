/** An ISO timestamp the way a reader sees it, or `'date unknown'` for one that will not parse. */
export function formatDate(iso: string, month: 'short' | 'long'): string {
    const when = new Date(iso);
    return Number.isNaN(when.getTime())
        ? 'date unknown'
        : when.toLocaleDateString(undefined, { year: 'numeric', month, day: 'numeric' });
}
