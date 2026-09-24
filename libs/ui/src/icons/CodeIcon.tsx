import type { IconProps } from './Icon.js';
import { Icon } from './Icon.js';

export function CodeIcon(props: IconProps): React.JSX.Element {
    return (
        <Icon {...props}>
            <path d="m5.5 4.5-3.5 3.5 3.5 3.5M10.5 4.5l3.5 3.5-3.5 3.5" />
        </Icon>
    );
}
