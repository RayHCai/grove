export function sleep(_seconds: number): Promise<void> {
    return Promise.resolve();
}

export function every(_seconds: number, _fn: () => void): () => void {
    return () => {};
}

export function after(_seconds: number, _fn: () => void): () => void {
    return () => {};
}
