import { act } from 'react';

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
