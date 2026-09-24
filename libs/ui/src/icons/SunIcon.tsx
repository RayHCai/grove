import type { IconProps } from './Icon.js';
import { Icon } from './Icon.js';

export function SunIcon(props: IconProps): React.JSX.Element {
    return (
        <Icon {...props}>
            <circle cx="8" cy="8" r="3" />
            <path d="M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
        </Icon>
    );
}
