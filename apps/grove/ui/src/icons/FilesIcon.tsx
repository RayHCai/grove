import type { IconProps } from './Icon.js';
import { Icon } from './Icon.js';

export function FilesIcon(props: IconProps): React.JSX.Element {
    return (
        <Icon {...props}>
            <path d="M8.5 1.5H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1V3z" />
            <path d="M8.5 1.5V4H11" />
            <path d="M6 14h6a1 1 0 0 0 1-1V6" />
        </Icon>
    );
}
