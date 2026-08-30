// Easing curves. Each maps t ∈ [0,1] to a value in [0,1] (with overshoot for bounce).
// Pure arithmetic, so a curve is deterministic by construction.

export type Easing = 'linear' | 'ease' | 'easeIn' | 'easeOut' | 'bounce';

export function ease(t: number, curve: Easing): number {
    switch (curve) {
        case 'linear':
            return t;
        case 'ease':
            return t * t * (3 - 2 * t);
        case 'easeIn':
            return t * t * t;
        case 'easeOut':
            return 1 - (1 - t) * (1 - t) * (1 - t);
        case 'bounce':
            return easeOutBounce(t);
    }
}

function easeOutBounce(t: number): number {
    if (t < 1 / 2.75) {
        return 7.5625 * t * t;
    } else if (t < 2 / 2.75) {
        const t2 = t - 1.5 / 2.75;
        return 7.5625 * t2 * t2 + 0.75;
    } else if (t < 2.5 / 2.75) {
        const t2 = t - 2.25 / 2.75;
        return 7.5625 * t2 * t2 + 0.9375;
    } else {
        const t2 = t - 2.625 / 2.75;
        return 7.5625 * t2 * t2 + 0.984375;
    }
}
