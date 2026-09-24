import type { IconProps } from './Icon.js';
import { Icon } from './Icon.js';

export function CloseIcon(props: IconProps): React.JSX.Element {
    return (
        <Icon {...props}>
            <path d="m4 4 8 8M12 4l-8 8" />
        </Icon>
    );
}
