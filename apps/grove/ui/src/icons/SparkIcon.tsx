import type { IconProps } from './Icon.js';
import { Icon } from './Icon.js';

export function SparkIcon(props: IconProps): React.JSX.Element {
    return (
        <Icon {...props}>
            <path d="M8 1.5c.6 3.7 2.8 5.9 6.5 6.5-3.7.6-5.9 2.8-6.5 6.5-.6-3.7-2.8-5.9-6.5-6.5 3.7-.6 5.9-2.8 6.5-6.5Z" />
        </Icon>
    );
}
