import type { Ref } from 'react';
import { FilesIcon, IconButton, SparkIcon, ThemeToggle } from '@grove/ui';

/** The panels the rail discloses, one at a time. */
export type PanelId = 'files' | 'ai';

export interface SideRailProps {
    panel: PanelId | null;
    onToggle: (panel: PanelId) => void;
    /** Reach the view buttons, so a closing panel can hand focus back to the one that opened it. */
    buttonRefs?: Readonly<Record<PanelId, Ref<HTMLButtonElement>>> | undefined;
}

const views = [
    { id: 'files', label: 'Explorer', controls: 'explorer-panel', Glyph: FilesIcon },
    { id: 'ai', label: 'Grove AI', controls: 'grove-ai-panel', Glyph: SparkIcon },
] as const;

/** The rail beside the workspace: the view disclosures on top, the theme toggle at the foot. */
export function SideRail({ panel, onToggle, buttonRefs }: SideRailProps): React.JSX.Element {
    return (
        <nav aria-label="Editor" className="rail">
            {views.map(({ id, label, controls, Glyph }) => (
                <IconButton
                    key={id}
                    ref={buttonRefs?.[id]}
                    label={label}
                    variant="ghost"
                    className="rail__view"
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
