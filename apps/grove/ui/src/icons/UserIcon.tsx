import type { IconProps } from './Icon.js';
import { Icon } from './Icon.js';

export function UserIcon(props: IconProps): React.JSX.Element {
    return (
        <Icon {...props}>
            <circle cx="8" cy="5.5" r="3" />
            <path d="M2.5 14.5c0-3.3 2.5-5 5.5-5s5.5 1.7 5.5 5" />
        </Icon>
    );
}
