import type { Ref } from 'react';
import { FilesIcon, IconButton, SettingsIcon, SparkIcon, ThemeToggle, cx } from '@grove/ui';

/** The panels the rail discloses, one at a time. */
export type PanelId = 'files' | 'ai' | 'settings';

export interface SideRailProps {
    panel: PanelId | null;
    onToggle: (panel: PanelId) => void;
    /** Reach the view buttons, so a closing panel can hand focus back to the one that opened it. */
    buttonRefs?: Readonly<Record<PanelId, Ref<HTMLButtonElement>>> | undefined;
}

// Settings sits at the foot rather than in the stack: it is the project's own dialog, not another
// view of the game's files.
const views = [
    { id: 'files', label: 'Explorer', controls: 'explorer-panel', Glyph: FilesIcon, foot: false },
    { id: 'ai', label: 'Grove AI', controls: 'grove-ai-panel', Glyph: SparkIcon, foot: false },
    {
        id: 'settings',
        label: 'Settings',
        controls: 'settings-panel',
        Glyph: SettingsIcon,
        foot: true,
    },
] as const;

/** The rail beside the workspace: the view disclosures on top, settings and the theme at the foot. */
export function SideRail({ panel, onToggle, buttonRefs }: SideRailProps): React.JSX.Element {
    return (
        <nav aria-label="Editor" className="rail">
            {views.map(({ id, label, controls, Glyph, foot }) => (
                <IconButton
                    key={id}
                    ref={buttonRefs?.[id]}
                    label={label}
                    variant="ghost"
                    className={cx('rail__view', foot && 'rail__foot')}
                    aria-expanded={panel === id}
                    aria-controls={controls}
                    onClick={() => onToggle(id)}
                >
                    <Glyph />
                </IconButton>
            ))}
            <ThemeToggle className="rail__theme" />
        </nav>
    );
}
