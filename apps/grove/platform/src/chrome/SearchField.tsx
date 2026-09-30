import type { ComponentPropsWithoutRef } from 'react';
import { SearchIcon, cx } from '@grove/ui';

export interface SearchFieldProps extends Omit<
    ComponentPropsWithoutRef<'input'>,
    'type' | 'aria-label' | 'placeholder'
> {
    /** The accessible name, which is also what the empty box says. */
    label: string;
}

/** A search box: the glass inside the sunk field, and the field's name as its placeholder. */
export function SearchField({ label, className, ...rest }: SearchFieldProps): React.JSX.Element {
    return (
        <label className={cx('search', className)}>
            <SearchIcon className="search__icon" size={16} />
            <input
                className="search__input"
                type="search"
                placeholder={label}
                aria-label={label}
                {...rest}
            />
        </label>
    );
}
