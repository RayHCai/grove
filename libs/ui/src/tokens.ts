/** The values every Grove surface renders against. */
export const tokens = {
    space: { xs: '4px', sm: '8px', md: '16px', lg: '24px', xl: '40px' },
    radius: { sm: '4px', md: '8px', lg: '16px', pill: '999px' },
    font: {
        body: 'system-ui, -apple-system, "Segoe UI", sans-serif',
        mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    },
} as const;

export type Tokens = typeof tokens;
