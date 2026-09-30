import type { IconProps } from './Icon.js';
import { SpriteIcon } from './Icon.js';

const ROWS = [
    '..###...',
    '..###...',
    '..###...',
    '........',
    '###.###.',
    '###.###.',
    '###.###.',
    '........',
];

export function BlocksIcon(props: IconProps): React.JSX.Element {
    return <SpriteIcon rows={ROWS} {...props} />;
}
