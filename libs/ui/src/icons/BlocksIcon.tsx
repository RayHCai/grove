import type { IconProps } from './Icon.js';
import { Icon } from './Icon.js';

export function BlocksIcon(props: IconProps): React.JSX.Element {
    return (
        <Icon {...props}>
            <rect x="5.5" y="1.5" width="5" height="5" rx="1" />
            <rect x="1.5" y="9.5" width="5" height="5" rx="1" />
            <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
        </Icon>
    );
}
