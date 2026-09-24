import type { IconProps } from './Icon.js';
import { Icon } from './Icon.js';

export function HeartIcon(props: IconProps): React.JSX.Element {
    return (
        <Icon {...props}>
            <path d="M12.7 9.3c1-1 2-2.1 2-3.7A3.7 3.7 0 0 0 11 2c-1.2 0-2 .3-3 1.3C7 2.3 6.2 2 5 2a3.7 3.7 0 0 0-3.7 3.6c0 1.6 1 2.7 2 3.7L8 14Z" />
        </Icon>
    );
}
