import type { IconProps } from './Icon.js';
import { Icon } from './Icon.js';

export function SettingsIcon(props: IconProps): React.JSX.Element {
    return (
        <Icon {...props}>
            <circle cx="8" cy="8" r="2" />
            <circle cx="8" cy="8" r="5" />
            <path d="M8 3V1.4M8 13v1.6M3 8H1.4M13 8h1.6M4.46 4.46 3.33 3.33M11.54 4.46l1.13-1.13M11.54 11.54l1.13 1.13M4.46 11.54l-1.13 1.13" />
        </Icon>
    );
}
