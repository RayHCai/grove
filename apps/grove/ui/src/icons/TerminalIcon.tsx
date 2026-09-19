import type { IconProps } from './Icon.js';
import { Icon } from './Icon.js';

export function TerminalIcon(props: IconProps): React.JSX.Element {
    return (
        <Icon {...props}>
            <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
            <path d="m4.5 6 2.5 2-2.5 2M8.5 10.5h3" />
        </Icon>
    );
}
