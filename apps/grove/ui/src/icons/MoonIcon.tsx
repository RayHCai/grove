import type { IconProps } from './Icon.js';
import { Icon } from './Icon.js';

export function MoonIcon(props: IconProps): React.JSX.Element {
    return (
        <Icon {...props}>
            <path d="M8 2a4 4 0 0 0 6 6 6 6 0 1 1-6-6Z" />
        </Icon>
    );
}
