import type { IconProps } from './Icon.js';
import { Icon } from './Icon.js';

export function MaximizeIcon(props: IconProps): React.JSX.Element {
    return (
        <Icon {...props}>
            <path d="M2 6V3a1 1 0 0 1 1-1h3M10 2h3a1 1 0 0 1 1 1v3M14 10v3a1 1 0 0 1-1 1h-3M6 14H3a1 1 0 0 1-1-1v-3" />
        </Icon>
    );
}
