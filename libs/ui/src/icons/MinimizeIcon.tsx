import type { IconProps } from './Icon.js';
import { Icon } from './Icon.js';

export function MinimizeIcon(props: IconProps): React.JSX.Element {
    return (
        <Icon {...props}>
            <path d="M5.5 2v2.5a1 1 0 0 1-1 1H2M14 5.5h-2.5a1 1 0 0 1-1-1V2M2 10.5h2.5a1 1 0 0 1 1 1V14M10.5 14v-2.5a1 1 0 0 1 1-1H14" />
        </Icon>
    );
}
