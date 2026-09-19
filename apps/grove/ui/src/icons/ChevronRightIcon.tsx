import type { IconProps } from './Icon.js';
import { Icon } from './Icon.js';

export function ChevronRightIcon(props: IconProps): React.JSX.Element {
    return (
        <Icon {...props}>
            <path d="m6 4 4 4-4 4" />
        </Icon>
    );
}
