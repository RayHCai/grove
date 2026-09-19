export interface TabsState {
    /** Open files in tab order. */
    readonly open: readonly string[];
    readonly active: string | null;
}

export type TabsAction =
    | { type: 'open'; path: string }
    | { type: 'select'; path: string }
    | { type: 'close'; path: string };

export function initialTabs(path: string): TabsState {
    return { open: [path], active: path };
}

/** Opening a file already on the strip selects it; closing the active one falls to its neighbour. */
export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
    if (action.type === 'select') {
        return state.open.includes(action.path) ? { ...state, active: action.path } : state;
    }
    if (action.type === 'open') {
        const open = state.open.includes(action.path) ? state.open : [...state.open, action.path];
        return { open, active: action.path };
    }
    const index = state.open.indexOf(action.path);
    if (index === -1) return state;
    const open = state.open.filter((path) => path !== action.path);
    if (state.active !== action.path) return { open, active: state.active };
    return { open, active: open[index] ?? open[index - 1] ?? null };
}
