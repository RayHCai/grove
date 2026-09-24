import type { IconProps } from './Icon.js';
import { Icon } from './Icon.js';

export function FileIcon(props: IconProps): React.JSX.Element {
    return (
        <Icon {...props}>
            <path d="M9 2H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V5z" />
            <path d="M9 2v3h3" />
        </Icon>
    );
}
