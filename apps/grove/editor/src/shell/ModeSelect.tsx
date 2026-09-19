import { BlocksIcon, CodeIcon, Select, cx } from '@grove/ui';
import type { SelectOption } from '@grove/ui';

export type Mode = 'ts' | 'blocks';

export interface ModeSelectProps {
    value: Mode;
    onChange: (mode: Mode) => void;
    className?: string | undefined;
}

const options: ReadonlyArray<SelectOption<Mode>> = [
    { value: 'ts', label: 'TypeScript', icon: <CodeIcon /> },
    {
        value: 'blocks',
        label: 'Blocks',
        icon: <BlocksIcon />,
        disabled: true,
        description: 'Coming soon',
    },
];

/** The authoring mode: a select named Mode listing TypeScript and a disabled Blocks. */
export function ModeSelect({ value, onChange, className }: ModeSelectProps): React.JSX.Element {
    return (
        <Select
            id="editor-mode"
            label="Mode"
            labelHidden
            size="sm"
            align="end"
            title="Mode"
            value={value}
            options={options}
            onChange={onChange}
            className={cx('mode-select', className)}
        />
    );
}
