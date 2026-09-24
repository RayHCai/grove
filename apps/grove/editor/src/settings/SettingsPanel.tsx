import { useState } from 'react';
import type { KeyboardEvent, Ref } from 'react';
import { CloseIcon, IconButton, SectionTitle, TextInput } from '@grove/ui';
import type { ProjectBounds, ProjectManifest, ProjectSettings } from '@platform/project';

export interface SettingsPanelProps {
    open: boolean;
    /** The manifest as the game holds it; the fields below are the part a creator sets. */
    project: ProjectManifest;
    /** One edited settings block, which the caller writes back into the manifest file. */
    onChange: (settings: ProjectSettings) => void;
    /** Runs on the close button and on Escape inside the panel; the caller returns focus. */
    onClose: () => void;
    ref?: Ref<HTMLElement> | undefined;
}

/**
 * The project settings, as the settings gear opens them.
 *
 * These are the build-time knobs: they are fixed when the world is built, so a compile reads them
 * and nothing at run time does. What the code declares — the classes, and the digest over them —
 * is not here at all, because a compile stamps that from the files themselves.
 */
export function SettingsPanel({
    open,
    project,
    onChange,
    onClose,
    ref,
}: SettingsPanelProps): React.JSX.Element {
    const settings = project.settings;

    function closeOnEscape(event: KeyboardEvent<HTMLElement>): void {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        onClose();
    }

    function setBound(edge: keyof ProjectBounds, value: number): void {
        onChange({ ...settings, bounds: { ...settings.bounds, [edge]: value } });
    }

    const declared = project.scriptModules.flatMap((module) => module.scripts).length;

    return (
        <aside
            id="settings-panel"
            aria-label="Project settings"
            className="side-panel settings-panel"
            ref={ref}
            tabIndex={-1}
            hidden={!open}
            data-open={open}
            onKeyDown={closeOnEscape}
        >
            <div className="side-panel__head">
                <h2 className="side-panel__title">Settings</h2>
                <IconButton label="Close" variant="ghost" size="sm" onClick={onClose}>
                    <CloseIcon />
                </IconButton>
            </div>
            <div className="settings-panel__body">
                <SectionTitle as="h3">The world</SectionTitle>
                <NumberField
                    label="Players"
                    hint="How many may be in one game at once."
                    value={settings.maxPlayers}
                    whole
                    onCommit={(maxPlayers) => onChange({ ...settings, maxPlayers })}
                />
                <NumberField
                    label="Sim rate"
                    hint="Ticks a second the world steps at."
                    value={settings.simRate}
                    whole
                    onCommit={(simRate) => onChange({ ...settings, simRate })}
                />
                <NumberField
                    label="Send rate"
                    hint="Updates a second each player is sent."
                    value={settings.sendRate}
                    whole
                    onCommit={(sendRate) => onChange({ ...settings, sendRate })}
                />

                <SectionTitle as="h3">Its extent</SectionTitle>
                <div className="settings-panel__grid">
                    <NumberField
                        label="Left"
                        value={settings.bounds.left}
                        onCommit={(value) => setBound('left', value)}
                    />
                    <NumberField
                        label="Right"
                        value={settings.bounds.right}
                        onCommit={(value) => setBound('right', value)}
                    />
                    <NumberField
                        label="Top"
                        value={settings.bounds.top}
                        onCommit={(value) => setBound('top', value)}
                    />
                    <NumberField
                        label="Bottom"
                        value={settings.bounds.bottom}
                        onCommit={(value) => setBound('bottom', value)}
                    />
                </div>

                <SectionTitle as="h3">What the code declares</SectionTitle>
                <p className="settings-panel__note">
                    {declared === 1 ? '1 script' : `${String(declared)} scripts`} in{' '}
                    {project.scriptModules.length === 1
                        ? '1 file'
                        : `${String(project.scriptModules.length)} files`}
                    , read from the code. Play stamps this again.
                </p>
            </div>
        </aside>
    );
}

interface NumberFieldProps {
    label: string;
    hint?: string;
    value: number;
    /** A rate or a head count: a positive whole number, which is what the format refuses below. */
    whole?: boolean;
    onCommit: (value: number) => void;
}

/**
 * A number, committed only while it is one.
 *
 * The draft is the field's own, because a half-typed `-` or an empty box is a thing to be in the
 * middle of typing and not a value to write into somebody's game.
 */
function NumberField({ label, hint, value, whole, onCommit }: NumberFieldProps): React.JSX.Element {
    const [draft, setDraft] = useState<string | null>(null);
    const shown = draft ?? String(value);
    const valid = isValidNumber(shown, whole);

    return (
        <TextInput
            label={label}
            {...(hint === undefined ? {} : { hint })}
            className="settings-panel__field"
            type="number"
            inputMode="numeric"
            {...(whole === true ? { min: 1, step: 1 } : {})}
            value={shown}
            aria-invalid={valid ? undefined : true}
            onChange={(event) => {
                setDraft(event.target.value);
                if (isValidNumber(event.target.value, whole)) onCommit(Number(event.target.value));
            }}
            // What the manifest holds is what the field shows again: a box left mid-edit would
            // otherwise keep claiming a value the game does not have.
            onBlur={() => setDraft(null)}
        />
    );
}

/** A rate or a head count is a positive whole number; anything else just has to parse. */
function isValidNumber(text: string, whole: boolean | undefined): boolean {
    const parsed = Number(text);
    return (
        text.trim() !== '' &&
        Number.isFinite(parsed) &&
        (whole !== true || (Number.isInteger(parsed) && parsed >= 1))
    );
}
