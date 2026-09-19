import type { IconProps } from './Icon.js';
import { Icon } from './Icon.js';

export function StopIcon(props: IconProps): React.JSX.Element {
    return (
        <Icon {...props}>
            <rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor" stroke="none" />
        </Icon>
    );
}
