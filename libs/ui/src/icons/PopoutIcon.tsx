import type { IconProps } from './Icon.js';
import { Icon } from './Icon.js';

export function PopoutIcon(props: IconProps): React.JSX.Element {
    return (
        <Icon {...props}>
            <path d="M9.5 2H14v4.5M14 2 8 8M12 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5" />
        </Icon>
    );
}
