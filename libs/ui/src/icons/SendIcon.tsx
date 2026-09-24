import type { IconProps } from './Icon.js';
import { Icon } from './Icon.js';

export function SendIcon(props: IconProps): React.JSX.Element {
    return (
        <Icon {...props}>
            <path d="M14.5 1.5 9.8 14.5 7.2 8.8 1.5 6.2Z" />
            <path d="M14.5 1.5 7.2 8.8" />
        </Icon>
    );
}
