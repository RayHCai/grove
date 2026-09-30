import type { IconProps } from './Icon.js';
import { SpriteIcon } from './Icon.js';

const ROWS = [
    '........',
    '###.....',
    '########',
    '########',
    '########',
    '########',
    '########',
    '........',
];

export function FolderIcon(props: IconProps): React.JSX.Element {
    return <SpriteIcon rows={ROWS} {...props} />;
}
