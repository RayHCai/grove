import type { IconProps } from './Icon.js';
import { Icon } from './Icon.js';

export function PauseIcon(props: IconProps): React.JSX.Element {
    return (
        <Icon {...props}>
            <rect x="3.5" y="3" width="3" height="10" rx="1" fill="currentColor" stroke="none" />
            <rect x="9.5" y="3" width="3" height="10" rx="1" fill="currentColor" stroke="none" />
        </Icon>
    );
}
