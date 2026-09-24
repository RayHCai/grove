import type { IconProps } from './Icon.js';
import { Icon } from './Icon.js';

export function LeafIcon(props: IconProps): React.JSX.Element {
    return (
        <Icon {...props}>
            <path d="M7.3 13.3A4.7 4.7 0 0 1 6.5 4.1C10.3 3.3 11.3 3 12.7 1.3c.7 1.3 1.3 2.8 1.3 5.3 0 3.7-3.2 6.7-6.7 6.7Z" />
            <path d="M1.3 14c0-2 1.2-3.6 3.4-4C6.3 9.7 8 8.7 8.7 8" />
        </Icon>
    );
}
