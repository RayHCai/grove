import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';

/**
 * Every root a case mounted, so the setup file can take them down again.
 *
 * A root left mounted stays subscribed to the router, and the next case's navigation would make a
 * stale app re-run its gates: two apps redirecting each other is a loop with no render in it.
 */
const mounted: Root[] = [];

/** Renders `ui` into a fresh host and flushes the first effects. */
export async function mount(ui: ReactNode): Promise<HTMLElement> {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);
    await act(async () => {
        root.render(ui);
    });
    return host;
}

/** Takes down everything `mount` put up, which is what unsubscribes it from the router. */
export function unmountAll(): void {
    act(() => {
        for (const root of mounted.splice(0)) root.unmount();
    });
}

/** Yields a macrotask at a time under `act` until `predicate` holds; running out of time is a failure. */
export async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start >= timeoutMs) {
            throw new Error(`the condition did not hold within ${String(timeoutMs)}ms`);
        }
        await act(async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        });
    }
}

/** Resolves once nothing under `host` is `aria-busy`. */
export async function untilSettled(host: HTMLElement): Promise<void> {
    await until(() => host.querySelector('[aria-busy="true"]') === null);
}

/** The element whose text is exactly `text`, which is how a test names a button or a link. */
export function byText<T extends Element>(
    host: HTMLElement,
    selector: string,
    text: string,
): T | undefined {
    return [...host.querySelectorAll<T>(selector)].find(
        (element) => element.textContent?.trim() === text,
    );
}

/** The one element whose text is exactly `text`; not finding it is a failure with the name in it. */
export function need<T extends Element>(host: HTMLElement, selector: string, text: string): T {
    const found = byText<T>(host, selector, text);
    if (found === undefined) throw new Error(`no ${selector} reading ${JSON.stringify(text)}`);
    return found;
}

/** Clicks an element and flushes what the click set off. */
export async function click(element: Element): Promise<void> {
    await act(async () => {
        (element as HTMLElement).click();
    });
}

/** Types into a controlled input the way React's own change handler expects. */
export async function type(input: HTMLInputElement, value: string): Promise<void> {
    await act(async () => {
        // The value has to be set through the prototype's own setter: React tracks the last value
        // it wrote on the node, and assigning directly leaves it thinking nothing changed.
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
            ?.set as (this: HTMLInputElement, next: string) => void;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

/** The field under a label, which is how a form's inputs are named here rather than by selector. */
export function field(host: HTMLElement, label: string): HTMLInputElement {
    const found = [...host.querySelectorAll('label')].find(
        (element) => element.textContent?.trim() === label,
    );
    if (found === undefined) throw new Error(`no field labelled ${JSON.stringify(label)}`);
    // An attribute selector rather than `#id`: React's generated ids carry characters an id
    // selector would have to escape, and this jsdom has no `CSS.escape` to do it with.
    const control = host.querySelector<HTMLInputElement>(`[id="${found.htmlFor}"]`);
    if (control === null) throw new Error(`the label ${JSON.stringify(label)} points at nothing`);
    return control;
}

/** Submits the form an element is in, the way pressing return in a field does. */
export async function submit(element: Element): Promise<void> {
    const form = element.closest('form');
    if (form === null) throw new Error('that element is not in a form');
    await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
}
