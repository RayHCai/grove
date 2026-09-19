import type { IconProps } from './Icon.js';
import { Icon } from './Icon.js';

export function ChevronDownIcon(props: IconProps): React.JSX.Element {
    return (
        <Icon {...props}>
            <path d="m4 6 4 4 4-4" />
        </Icon>
    );
}
