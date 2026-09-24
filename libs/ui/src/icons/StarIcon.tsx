import type { IconProps } from './Icon.js';
import { Icon } from './Icon.js';

export function StarIcon(props: IconProps): React.JSX.Element {
    return (
        <Icon {...props}>
            <path d="m8 2 1.7 4.15 4.5.35-3.4 2.9 1 4.4L8 11.4l-3.8 2.4 1-4.4-3.4-2.9 4.5-.35Z" />
        </Icon>
    );
}
