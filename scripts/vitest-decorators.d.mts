/** A Vite plugin that hands each decorated TypeScript module to esbuild before Vitest sees it. */
export function standardDecorators(): {
    name: string;
    enforce: 'pre';
    transform(code: string, id: string): Promise<{ code: string; map: string } | null>;
};
