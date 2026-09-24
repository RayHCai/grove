import * as monaco from 'monaco-editor/editor';
// Every editor feature is registered by this side effect; nothing under editor/ pulls them in.
// oxlint-disable-next-line import/no-unassigned-import
import 'monaco-editor/features/register.all';
// The TypeScript grammar alone; the package root would register every other language too.
// oxlint-disable-next-line import/no-unassigned-import
import 'monaco-editor/languages/definitions/typescript/register';
import {
    ModuleKind,
    ModuleResolutionKind,
    getTypeScriptWorker,
    typescriptDefaults,
} from 'monaco-editor/languages/features/typescript/register';
import type {
    Diagnostic,
    ScriptTarget,
} from 'monaco-editor/languages/features/typescript/register';
import { fonts, readThemeColors } from '@grove/ui';
import type { Theme, ThemeColors } from '@grove/ui';
import { GLOBALS_DTS, GLOBALS_PATH } from '../project/prelude';
import { engineTypeLibs } from './types';

/** One file as the workbench holds it: where it lives, what it is called, and what is in it. */
export interface EditorFile {
    path: string;
    name: string;
    language: string;
    value: string;
}

export interface MountOptions {
    /** The file to open on; `null` mounts an editor with nothing in it. */
    file: EditorFile | null;
    theme: Theme;
}

/** One complaint from the checker, positioned the way the console pane prints it. */
export interface Problem {
    path: string;
    line: number;
    column: number;
    message: string;
    severity: 'error' | 'warning';
    /** A broken parse rather than a wrong type: the JavaScript beside it cannot be trusted. */
    syntactic: boolean;
}

/** What one compile produced: the emitted modules, keyed by name, and what the checker said. */
export interface EmitResult {
    modules: Record<string, string>;
    problems: Problem[];
}

export interface EditorHandle {
    dispose(): void;
    setTheme(theme: Theme): void;
    /**
     * Every file the checker and the emitter may see. One not listed here is dropped.
     *
     * Wider than what is on screen, deliberately: a program is all of its files, so a file with no
     * model is an unresolved import in every other one and a module a local run would be missing.
     */
    syncFiles(files: readonly EditorFile[]): void;
    /** Which of them is in front of the caret. */
    openFile(file: EditorFile | null): void;
    getValue(): string;
    /** Called on every keystroke, with the path typed in and everything now in it. */
    onChange(listener: (path: string, text: string) => void): void;
    emit(): Promise<EmitResult>;
}

const THEME_NAME = 'grove';
const TRANSPARENT = '#00000000';

/** The worker's own TypeScript numbers this target; the enum monaco re-declares stops at ES2020. */
const ES2022 = 9 as ScriptTarget;

/** The scheme every model lives under, so one path is one uri and one uri is one path. */
const WORKSPACE = 'inmemory://grove/';

self.MonacoEnvironment = {
    getWorker: (_id, label) =>
        label === 'typescript' || label === 'javascript'
            ? new Worker(
                  new URL(
                      'monaco-editor/languages/features/typescript/ts.worker.js',
                      import.meta.url,
                  ),
                  { type: 'module' },
              )
            : new Worker(new URL('monaco-editor/editor/editor.worker.js', import.meta.url), {
                  type: 'module',
              }),
};

function bare(hex: string): string {
    return hex.startsWith('#') ? hex.slice(1) : hex;
}

// Nothing is inherited from vs/vs-dark: every token the rules leave out falls to editor.foreground.
function buildThemeData(theme: Theme, colors: ThemeColors): monaco.editor.IStandaloneThemeData {
    const dark = theme === 'dark';
    return {
        base: dark ? 'vs-dark' : 'vs',
        inherit: false,
        rules: [
            { token: 'keyword', foreground: bare(colors['code-keyword']) },
            { token: 'string', foreground: bare(colors['code-string']) },
            { token: 'number', foreground: bare(colors['code-number']) },
            { token: 'type', foreground: bare(colors['code-type']) },
            { token: 'comment', foreground: bare(colors['code-comment']) },
        ],
        colors: {
            'editor.background': colors.surface,
            'editor.foreground': colors.ink,
            'editor.lineHighlightBackground': colors['code-line'],
            'editor.lineHighlightBorder': TRANSPARENT,
            'editor.selectionBackground': colors['code-selection'],
            'editor.findMatchBackground': colors['code-selection'],
            'editor.findMatchHighlightBackground': colors['code-selection'],
            'editor.wordHighlightBackground': colors['code-selection'],
            'editor.wordHighlightStrongBackground': colors['code-selection'],
            'editorCursor.foreground': colors.warm,
            'editorGutter.background': colors.surface,
            'editorLineNumber.foreground': colors['ink-faint'],
            'editorLineNumber.activeForeground': colors.ink,
            'editorIndentGuide.background1': colors.border,
            'editorIndentGuide.activeBackground1': colors['border-strong'],
            'editorBracketMatch.background': colors['code-selection'],
            'editorBracketMatch.border': colors['border-strong'],
            'editorBracketHighlight.foreground1': dark ? colors.accent : colors['code-string'],
            'editorBracketHighlight.foreground2': dark ? colors.warm : colors['code-keyword'],
            'editorBracketHighlight.foreground3': dark ? colors.sun : colors['code-number'],
            'editorWhitespace.foreground': colors['ink-faint'],
            'editorError.foreground': colors.warm,
            'editorWarning.foreground': colors.sun,
            'editorInfo.foreground': colors['ink-faint'],
            'editorLink.activeForeground': colors['warm-ink'],
            'editorWidget.background': colors.surface,
            'editorWidget.foreground': colors.ink,
            'editorWidget.border': colors.border,
            'editorSuggestWidget.background': colors.surface,
            'editorSuggestWidget.foreground': colors.ink,
            'editorSuggestWidget.border': colors.border,
            'editorSuggestWidget.highlightForeground': colors['warm-ink'],
            'editorSuggestWidget.selectedBackground': colors['accent-soft'],
            'editorSuggestWidget.selectedForeground': colors.ink,
            'editorSuggestWidget.focusHighlightForeground': colors['warm-ink'],
            'editorHoverWidget.background': colors.surface,
            'editorHoverWidget.foreground': colors.ink,
            'editorHoverWidget.border': colors.border,
            focusBorder: colors.accent,
            'scrollbarSlider.background': colors['code-selection'],
            'scrollbarSlider.hoverBackground': colors['ink-faint'],
            'scrollbarSlider.activeBackground': colors['ink-faint'],
        },
    };
}

function applyTheme(theme: Theme): void {
    monaco.editor.defineTheme(THEME_NAME, buildThemeData(theme, readThemeColors()));
    monaco.editor.setTheme(THEME_NAME);
}

function prefersReducedMotion(): boolean {
    return (
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
}

/** What one complaint reads as once the chain a checker nests it in is flattened. */
function messageOf(message: Diagnostic['messageText']): string {
    if (typeof message === 'string') return message;
    if (message === undefined) return 'the checker said nothing';
    return [message.messageText, ...(message.next ?? []).map(messageOf)].join(' ');
}

/**
 * Mounts the workbench: one Monaco editor over a model per project file, in Grove colours.
 *
 * The handle is the only way back in.
 */
export function mountEditor(host: HTMLElement, { file, theme }: MountOptions): EditorHandle {
    typescriptDefaults.setCompilerOptions({
        // ES2022, not ESNext: TypeScript emits a standard decorator verbatim for a target that
        // claims to have them, and no browser does — a `@onStart` would reach the run unlowered.
        target: ES2022,
        module: ModuleKind.ESNext,
        moduleResolution: ModuleResolutionKind.NodeJs,
        // No DOM: a game is not a page, and two engine names — `Storage` and `Animation` — would
        // collide outright with that library's.
        lib: ['es2023'],
        strict: true,
        // The workbench is also the compiler a local run uses, and `getEmitOutput` against a
        // program told not to emit hands back nothing.
        noEmit: false,
        allowNonTsExtensions: true,
        // The engine's own declarations are shipped as built, and checking them again here would
        // report the engine's own faults inside somebody's game.
        skipLibCheck: true,
    });
    // Replaces rather than adds, so a second mount holds one copy of each declaration.
    typescriptDefaults.setExtraLibs([
        ...engineTypeLibs(),
        { content: GLOBALS_DTS, filePath: GLOBALS_PATH },
    ]);
    applyTheme(theme);

    const models = new Map<string, monaco.editor.ITextModel>();
    const watchers = new Map<string, monaco.IDisposable>();
    let listener: ((path: string, text: string) => void) | undefined;

    function modelFor({ path, language, value }: EditorFile): monaco.editor.ITextModel {
        const held = models.get(path);
        if (held !== undefined) return held;

        const model = monaco.editor.createModel(
            value,
            language,
            monaco.Uri.parse(`${WORKSPACE}${path}`),
        );
        models.set(path, model);
        watchers.set(
            path,
            model.onDidChangeContent(() => {
                listener?.(path, model.getValue());
            }),
        );
        return model;
    }

    function drop(path: string): void {
        watchers.get(path)?.dispose();
        watchers.delete(path);
        const model = models.get(path);
        if (model === undefined) return;
        if (editor.getModel() === model) editor.setModel(null);
        models.delete(path);
        model.dispose();
    }

    const reduced = prefersReducedMotion();
    const editor = monaco.editor.create(host, {
        theme: THEME_NAME,
        ariaLabel: file?.name ?? 'Code',
        fontFamily: fonts.mono,
        fontSize: 11,
        // VS Code's macOS ratio, taken as the one value on every platform.
        lineHeight: 17,
        fontLigatures: true,
        letterSpacing: 0,
        cursorStyle: 'line',
        cursorWidth: 2,
        cursorBlinking: reduced ? 'solid' : 'smooth',
        cursorSmoothCaretAnimation: reduced ? 'off' : 'on',
        smoothScrolling: !reduced,
        roundedSelection: true,
        renderLineHighlight: 'line',
        lineNumbersMinChars: 3,
        glyphMargin: false,
        folding: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        overviewRulerBorder: false,
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
        padding: { top: 8, bottom: 8 },
        automaticLayout: true,
        tabSize: 4,
        guides: { bracketPairs: 'active', indentation: true },
    });
    if (file !== null) editor.setModel(modelFor(file));

    // One callback per mount: the DOM dedupes listeners by reference, so a shared one would let
    // the first dispose() unhook an editor that is still alive.
    const remeasure = (): void => {
        monaco.editor.remeasureFonts();
        editor.render();
    };
    document.fonts?.ready.then(remeasure).catch(() => undefined);
    document.fonts?.addEventListener('loadingdone', remeasure);

    return {
        syncFiles(files) {
            const wanted = new Set(files.map((each) => each.path));
            // Snapshotted, because dropping one removes it from the map being walked.
            const held = [...models.keys()];
            for (const path of held) {
                if (!wanted.has(path)) drop(path);
            }
            // Only creates; a model already open holds what is typed in it, which the caller's
            // copy of the text is downstream of rather than an authority over.
            for (const each of files) modelFor(each);
        },

        openFile(next) {
            if (next === null) {
                editor.setModel(null);
                return;
            }
            editor.updateOptions({ ariaLabel: next.name });
            editor.setModel(modelFor(next));
        },

        getValue: () => editor.getModel()?.getValue() ?? '',

        onChange(next) {
            listener = next;
        },

        async emit() {
            const worker = await getTypeScriptWorker();
            const modules: Record<string, string> = {};
            const problems: Problem[] = [];

            // One file at a time, because one worker holds the program: asking it for every file
            // at once queues the same work behind the same thread and only hides the order.
            /* oxlint-disable no-await-in-loop */
            for (const [path, model] of models) {
                if (model.getLanguageId() !== 'typescript') continue;
                const client = await worker(model.uri);
                const name = model.uri.toString();

                for (const [kind, found] of [
                    ['syntactic', await client.getSyntacticDiagnostics(name)],
                    ['semantic', await client.getSemanticDiagnostics(name)],
                ] as const) {
                    for (const diagnostic of found) {
                        const at = model.getPositionAt(diagnostic.start ?? 0);
                        problems.push({
                            path,
                            line: at.lineNumber,
                            column: at.column,
                            message: messageOf(diagnostic.messageText),
                            // 1 is an error; anything softer is a suggestion nobody has to act on.
                            severity: diagnostic.category === 1 ? 'error' : 'warning',
                            syntactic: kind === 'syntactic',
                        });
                    }
                }

                const emitted = await client.getEmitOutput(name);
                for (const output of emitted.outputFiles) {
                    if (output.name.endsWith('.js')) {
                        modules[output.name.slice(WORKSPACE.length)] = output.text;
                    }
                }
                // A file the emitter skipped is a module the run would be missing.
                if (emitted.emitSkipped) {
                    problems.push({
                        path,
                        line: 1,
                        column: 1,
                        message: 'the compiler emitted nothing for this file',
                        severity: 'error',
                        syntactic: true,
                    });
                }
            }
            /* oxlint-enable no-await-in-loop */

            return { modules, problems };
        },

        setTheme: applyTheme,

        dispose() {
            document.fonts?.removeEventListener('loadingdone', remeasure);
            for (const watcher of watchers.values()) watcher.dispose();
            watchers.clear();
            editor.dispose();
            for (const model of models.values()) model.dispose();
            models.clear();
        },
    };
}
