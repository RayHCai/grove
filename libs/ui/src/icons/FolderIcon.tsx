import type { IconProps } from './Icon.js';
import { Icon } from './Icon.js';

export function FolderIcon(props: IconProps): React.JSX.Element {
    return (
        <Icon {...props}>
            <path d="M2 12.5v-9a.5.5 0 0 1 .5-.5h3.2a.5.5 0 0 1 .4.2l1 1.3h6.4a.5.5 0 0 1 .5.5v7.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5z" />
        </Icon>
    );
}
