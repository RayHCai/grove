import type { IconProps } from './Icon.js';
import { Icon } from './Icon.js';

export function PlayIcon(props: IconProps): React.JSX.Element {
    return (
        <Icon {...props}>
            <path
                d="M4 3.2a1 1 0 0 1 1.5-.87l8 4.8a1 1 0 0 1 0 1.74l-8 4.8A1 1 0 0 1 4 12.8Z"
                fill="currentColor"
                stroke="none"
            />
        </Icon>
    );
}
