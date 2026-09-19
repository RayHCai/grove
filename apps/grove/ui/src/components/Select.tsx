import { useEffect, useId, useRef, useState } from 'react';
import type { ComponentPropsWithRef, KeyboardEvent, ReactNode } from 'react';
import { cx } from '../cx.js';
import { ChevronDownIcon } from '../icons/ChevronDownIcon.js';
import { Button, isAriaDisabled } from './Button.js';
import { Panel } from './Panel.js';
import { VisuallyHidden } from './VisuallyHidden.js';

export type SelectSize = 'md' | 'sm';

export interface SelectOption<T extends string = string> {
    value: T;
    label: string;
    /** A second line read inside the option, such as "Coming soon". */
    description?: string | undefined;
    disabled?: boolean | undefined;
    icon?: ReactNode | undefined;
}

export interface SelectProps<T extends string = string> extends Omit<
    ComponentPropsWithRef<'button'>,
    | 'value'
    | 'onChange'
    | 'children'
    | 'role'
    | 'type'
    | 'aria-haspopup'
    | 'aria-expanded'
    | 'aria-controls'
    | 'aria-labelledby'
    | 'aria-activedescendant'
> {
    /** The accessible name; rendered beside the trigger unless `labelHidden`. */
    label: string;
    labelHidden?: boolean | undefined;
    value: T;
    options: ReadonlyArray<SelectOption<T>>;
    onChange: (value: T) => void;
    /** The trigger's id; the label, value and listbox ids derive from it. */
    id?: string | undefined;
    size?: SelectSize | undefined;
    /** Which edge of the trigger the list hangs from; `end` keeps it inside a pane's right edge. */
    align?: 'start' | 'end' | undefined;
}

function keepFocus(event: { preventDefault: () => void }): void {
    event.preventDefault();
}

/** A select-only combobox: a secondary-button trigger that opens a listbox panel. */
export function Select<T extends string = string>({
    label,
    labelHidden = false,
    value,
    options,
    onChange,
    id,
    size = 'sm',
    align = 'start',
    className,
    onClick,
    onKeyDown,
    onBlur,
    ...rest
}: SelectProps<T>): React.JSX.Element {
    const autoId = useId();
    const baseId = id ?? autoId;
    const labelId = `${baseId}-label`;
    const valueId = `${baseId}-value`;
    const listId = `${baseId}-list`;
    const rootRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(0);
    const inert = isAriaDisabled(rest['aria-disabled']);
    const selectedIndex = options.findIndex((option) => option.value === value);
    const selected = options[selectedIndex];
    const last = Math.max(options.length - 1, 0);

    useEffect(() => {
        if (!open) return undefined;
        const root = rootRef.current;
        const closeOnOutsidePress = (event: MouseEvent): void => {
            if (root !== null && event.target instanceof Node && !root.contains(event.target)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', closeOnOutsidePress);
        return () => {
            document.removeEventListener('mousedown', closeOnOutsidePress);
        };
    }, [open]);

    function openAt(index: number): void {
        setActive(Math.min(Math.max(index, 0), last));
        setOpen(true);
    }

    function commit(index: number): boolean {
        const chosen = options[index];
        if (chosen === undefined || chosen.disabled === true) return false;
        if (chosen.value !== value) onChange(chosen.value);
        setOpen(false);
        return true;
    }

    function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
        onKeyDown?.(event);
        if (event.defaultPrevented || inert) return;
        if (!open) {
            switch (event.key) {
                case 'ArrowDown':
                case 'ArrowUp':
                case 'Enter':
                case ' ':
                    event.preventDefault();
                    openAt(selectedIndex);
                    break;
                case 'Home':
                    event.preventDefault();
                    openAt(0);
                    break;
                case 'End':
                    event.preventDefault();
                    openAt(last);
                    break;
                default:
            }
            return;
        }
        switch (event.key) {
            case 'ArrowDown':
                event.preventDefault();
                setActive((current) => Math.min(current + 1, last));
                break;
            case 'ArrowUp':
                event.preventDefault();
                if (event.altKey) {
                    commit(active);
                } else {
                    setActive((current) => Math.max(current - 1, 0));
                }
                break;
            case 'Home':
                event.preventDefault();
                setActive(0);
                break;
            case 'End':
                event.preventDefault();
                setActive(last);
                break;
            case 'Enter':
            case ' ':
                event.preventDefault();
                commit(active);
                break;
            case 'Escape':
                event.preventDefault();
                setOpen(false);
                break;
            case 'Tab':
                if (!commit(active)) setOpen(false);
                break;
            default:
        }
    }

    return (
        <div
            ref={rootRef}
            className={cx('pg-select', align === 'end' && 'pg-select--end', className)}
        >
            {labelHidden ? (
                <VisuallyHidden id={labelId}>{label}</VisuallyHidden>
            ) : (
                <span id={labelId} className="pg-select__label">
                    {label}
                </span>
            )}
            <div className="pg-select__control">
                <Button
                    id={baseId}
                    variant="secondary"
                    size={size}
                    className="pg-select__trigger"
                    role="combobox"
                    aria-haspopup="listbox"
                    aria-expanded={open}
                    aria-controls={listId}
                    aria-labelledby={`${labelId} ${valueId}`}
                    aria-activedescendant={open ? `${baseId}-option-${active}` : undefined}
                    icon={selected?.icon}
                    iconEnd={<ChevronDownIcon className="pg-select__chevron" />}
                    onClick={(event) => {
                        onClick?.(event);
                        if (event.defaultPrevented) return;
                        if (open) {
                            setOpen(false);
                        } else {
                            openAt(selectedIndex);
                        }
                    }}
                    onKeyDown={handleKeyDown}
                    onBlur={(event) => {
                        onBlur?.(event);
                        const next = event.relatedTarget;
                        if (next === null || !rootRef.current?.contains(next)) setOpen(false);
                    }}
                    {...rest}
                >
                    <span id={valueId} className="pg-select__value">
                        {selected?.label}
                    </span>
                </Button>
                <Panel
                    role="listbox"
                    id={listId}
                    aria-labelledby={labelId}
                    tabIndex={-1}
                    hidden={!open}
                    className="pg-select__list"
                    onMouseDown={keepFocus}
                >
                    {options.map((option, index) => (
                        <div
                            key={option.value}
                            role="option"
                            id={`${baseId}-option-${index}`}
                            aria-selected={index === selectedIndex}
                            aria-disabled={option.disabled === true ? 'true' : undefined}
                            className={cx(
                                'pg-select__option',
                                index === active && 'pg-select__option--active',
                            )}
                            onMouseMove={() => setActive(index)}
                            onClick={() => commit(index)}
                        >
                            {option.icon !== undefined && option.icon !== null && (
                                <span className="pg-select__icon">{option.icon}</span>
                            )}
                            <span className="pg-select__text">
                                {option.label}
                                {option.description !== undefined && (
                                    <span className="pg-select__description">
                                        {option.description}
                                    </span>
                                )}
                            </span>
                        </div>
                    ))}
                </Panel>
            </div>
        </div>
    );
}
