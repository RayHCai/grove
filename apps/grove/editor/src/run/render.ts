// What a value looks like in the console pane.
//
// `harness.js` carries its own copy of this, and has to: it is inlined into a sandboxed document as
// text and imports nothing. The two are kept alike so one game's logging does not read differently
// depending on which stage it ran on.

/** How far into an object the pane goes before it says there is more. */
const DEPTH = 3;

function render(value: unknown, depth: number): string {
    if (typeof value === 'string') return depth === 0 ? value : JSON.stringify(value);
    if (value === null || value === undefined) return String(value);
    if (typeof value === 'function') return `function ${value.name || '(anonymous)'}`;
    if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
    if (typeof value !== 'object') return String(value);
    if (depth >= DEPTH) return Array.isArray(value) ? '[…]' : '{…}';

    if (Array.isArray(value)) {
        return `[${value.map((item) => render(item, depth + 1)).join(', ')}]`;
    }
    return `{${Object.entries(value)
        .map(([key, held]) => `${key}: ${render(held, depth + 1)}`)
        .join(', ')}}`;
}

/** One console line: every argument rendered and joined, the way a browser's own console reads. */
export function renderLine(values: readonly unknown[]): string {
    try {
        return values.map((value) => render(value, 0)).join(' ');
    } catch {
        // A getter that throws must not take the run down with it.
        return '[a value could not be rendered]';
    }
}
