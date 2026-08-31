// Deterministic replacements for the ECMA-262 implementation-approximated functions: two machines
// must produce identical results from identical inputs, which the built-in transcendentals do not
// guarantee, so these use polynomial/range-reduction over exact IEEE-754 operations only.
//
// Only sin, cos, atan, exp and log carry their own approximation; everything below them is
// derived by identity, so a precision fix belongs in one of those five.
//
// Not replaced, because they are already exact IEEE-754 and agree bit-for-bit on every target:
// abs, sign, min, max, floor, ceil, round, trunc, fround, sqrt.

const PI = 3.141592653589793;
const HALF_PI = 1.5707963267948966;
const INV_HALF_PI = 0.6366197723675814;

// π/2 in three pieces that sum to it, each holding the bits the one before it dropped. `PIO2_1`'s
// low 33 bits are zero, so `n * PIO2_1` is exact for every quadrant count this reduction sees and
// the subtraction below loses nothing — which is the whole reason the split exists.
const PIO2_1 = 1.5707963267341256;
const PIO2_2 = 6.077100506303966e-11;
const PIO2_2T = 2.0222662487959506e-21;

/**
 * `x` as a quadrant count and a remainder in [−π/4, π/4], which is where both kernels are accurate.
 *
 * Reducing to [−π/2, π/2] and running one kernel over it instead costs ~5e-8 at the ends of that
 * range — worst exactly at the quadrant boundaries, which is where `cos(0)` lands when cosine is
 * spelled `sin(x + π/2)`.
 */
function reduceQuadrant(x: number): { q: number; r: number } {
    const n = Math.round(x * INV_HALF_PI);
    if (n === 0) return { q: 0, r: x };

    const head = x - n * PIO2_1;
    // Each correction is subtracted separately rather than folded into one constant: `n * PIO2_2`
    // rounds away bits that matter once n is large, and `PIO2_2T` is exactly those bits.
    const mid = head - n * PIO2_2;
    const tail = n * PIO2_2T - (head - mid - n * PIO2_2);
    // Arithmetic, never bitwise: `n & 3` wraps at int32, so every angle past 2^31 quadrants — which
    // is a reachable double — would select the wrong kernel rather than merely lose precision.
    return { q: ((n % 4) + 4) % 4, r: mid - tail };
}

// fdlibm's minimax kernels for |x| <= π/4. Both are written so the leading terms cancel exactly:
// `x + x³·P` rather than `x·(1 + x²·P)`, and cosine's `(1 − w) − hz` recovers the rounding of
// `1 − x²/2`, which is the term that decides whether `cos(0)` is 1 or merely close to it.
function sinKernel(x: number): number {
    const z = x * x;
    const p =
        -1.6666666666666632e-1 +
        z *
            (8.3333333333224895e-3 +
                z *
                    (-1.9841269829857949e-4 +
                        z *
                            (2.7557313707070068e-6 +
                                z * (-2.5050760253406863e-8 + z * 1.5896909952115501e-10))));
    return x + x * z * p;
}

function cosKernel(x: number): number {
    const z = x * x;
    const p =
        4.1666666666666602e-2 +
        z *
            (-1.3888888888874109e-3 +
                z *
                    (2.4801587289476729e-5 +
                        z *
                            (-2.7557314351390663e-7 +
                                z * (2.0875723212981748e-9 - z * 1.1359647557788195e-11))));
    const hz = 0.5 * z;
    const w = 1 - hz;
    return w + (1 - w - hz + z * z * p);
}

export function sin(x: number): number {
    if (x !== x) return NaN;
    if (!isFinite(x)) return NaN;
    // -0 in, -0 out: the kernel would return +0 and a caller mirroring a position would lose the sign.
    if (x === 0) return x;

    const { q, r } = reduceQuadrant(x);
    switch (q) {
        case 0:
            return sinKernel(r);
        case 1:
            return cosKernel(r);
        case 2:
            return -sinKernel(r);
        default:
            return -cosKernel(r);
    }
}

export function cos(x: number): number {
    if (x !== x) return NaN;
    if (!isFinite(x)) return NaN;

    const { q, r } = reduceQuadrant(x);
    switch (q) {
        case 0:
            return cosKernel(r);
        case 1:
            return -sinKernel(r);
        case 2:
            return -cosKernel(r);
        default:
            return sinKernel(r);
    }
}

export function tan(x: number): number {
    const c = cos(x);
    if (c === 0) return x > 0 ? Infinity : -Infinity;
    return sin(x) / c;
}

// ±1/(2k+3), highest power first, so the Horner walk below runs smallest term first. Carried to
// x³³ because the halving in `atan` only brings the argument down to 0.414, where stopping at x²¹
// leaves 7e-11 of truncation — three orders worse than everything else in this module.
const ATAN_COEFFICIENTS = [
    1 / 33,
    -1 / 31,
    1 / 29,
    -1 / 27,
    1 / 25,
    -1 / 23,
    1 / 21,
    -1 / 19,
    1 / 17,
    -1 / 15,
    1 / 13,
    -1 / 11,
    1 / 9,
    -1 / 7,
    1 / 5,
    -1 / 3,
] as const;

/** arctan on |x| <= tan(π/8), by its own series: −x³/3 + x⁵/5 − x⁷/7 … */
function atanKernel(x: number): number {
    const z = x * x;
    let poly = 0;
    for (const c of ATAN_COEFFICIENTS) poly = c + z * poly;
    return x + x * z * poly;
}

export function atan(x: number): number {
    if (x !== x) return NaN;
    if (x === 0) return x;
    if (x === Infinity) return HALF_PI;
    if (x === -Infinity) return -HALF_PI;

    let negate = false;
    let recip = false;
    let a = x;

    if (a < 0) {
        a = -a;
        negate = true;
    }
    if (a > 1) {
        a = 1 / a;
        recip = true;
    }

    let result: number;
    if (a > 0.4142135623730950488) {
        const reduced = (a - 1) / (a + 1);
        result = 0.7853981633974483 + atanKernel(reduced);
    } else {
        result = atanKernel(a);
    }

    if (recip) result = HALF_PI - result;
    if (negate) result = -result;
    return result;
}

export function atan2(y: number, x: number): number {
    if (y !== y || x !== x) return NaN;
    if (y === 0) {
        if (x > 0 || (x === 0 && 1 / x > 0)) return Object.is(y, -0) ? -0 : 0;
        return Object.is(y, -0) ? -PI : PI;
    }
    if (x === 0) return y > 0 ? HALF_PI : -HALF_PI;
    if (!isFinite(y)) {
        if (!isFinite(x)) {
            const q = x > 0 ? 0.7853981633974483 : 2.356194490192345;
            return y > 0 ? q : -q;
        }
        return y > 0 ? HALF_PI : -HALF_PI;
    }
    if (!isFinite(x)) {
        // y is finite and nonzero here, so its sign carries the sign of the ±0 result.
        return x > 0 ? (y < 0 ? -0 : 0) : y > 0 ? PI : -PI;
    }

    let a = atan(y / x);
    if (x < 0) a += y >= 0 ? PI : -PI;
    return a;
}

export function asin(x: number): number {
    if (x !== x || x < -1 || x > 1) return NaN;
    if (x === 1) return HALF_PI;
    if (x === -1) return -HALF_PI;
    return atan2(x, Math.sqrt(1 - x * x));
}

export function acos(x: number): number {
    if (x !== x || x < -1 || x > 1) return NaN;
    if (x === 1) return 0;
    if (x === -1) return PI;
    return atan2(Math.sqrt(1 - x * x), x);
}

const LN2_HI = 0.6931471803691238;
const LN2_LO = 1.9082149292705877e-10;
const INV_LN2 = 1.4426950408889634;

// Math.pow / Math.log2 are ECMA-262 approximated; exp/log build 2^k and frexp from
// exponent bits instead so the results are exact IEEE-754 ops and reproduce everywhere.
const scratch64 = new Float64Array(1);
const scratch32 = new Uint32Array(scratch64.buffer);
scratch64[0] = 1;
const HI = scratch32[0] === 0x3ff00000 ? 0 : 1;
const LO = 1 - HI;

// 2^k by exponent-bit construction, for -1022 <= k <= 1023 (normal range).
function pow2(k: number): number {
    scratch64[0] = 0;
    scratch32[LO] = 0;
    scratch32[HI] = (k + 1023) << 20;
    return scratch64[0];
}

const TWO1023 = pow2(1023);
const TWO_M969 = pow2(-969);
const TWO54 = pow2(54);

// m * 2^k, staged through representable factors so k outside [-1022, 1023] can't overflow mid-step.
function scalbn(m: number, k: number): number {
    if (k > 1023) {
        m *= TWO1023;
        k -= 1023;
        if (k > 1023) {
            m *= TWO1023;
            k -= 1023;
            if (k > 1023) k = 1023;
        }
    } else if (k < -1022) {
        m *= TWO_M969;
        k += 969;
        if (k < -1022) {
            m *= TWO_M969;
            k += 969;
            if (k < -1022) k = -1022;
        }
    }
    return m * pow2(k);
}

export function exp(x: number): number {
    if (x !== x) return NaN;
    if (x === 0) return 1;
    if (x === Infinity) return Infinity;
    if (x === -Infinity) return 0;
    if (x > 709.782712893384) return Infinity;
    if (x < -745.13321910194) return 0;

    const k = Math.round(x * INV_LN2);
    const r = x - k * LN2_HI - k * LN2_LO;
    const r2 = r * r;
    const c =
        r -
        r2 *
            (0.16666666666666602 -
                r2 *
                    (0.0027777777777015593 -
                        r2 *
                            (0.00006613756321437934 -
                                r2 * (0.0000016533902205465252 - r2 * 4.1381367970572385e-8))));
    const expR = 1 + r + (r * c) / (2 - c);
    if (k === 0) return expR;
    return scalbn(expR, k);
}

export function log(x: number): number {
    if (x !== x) return NaN;
    if (x < 0) return NaN;
    if (x === 0) return -Infinity;
    if (x === Infinity) return Infinity;
    if (x === 1) return 0;

    // frexp via exponent bits, then split the mantissa around √2 so |f| stays small.
    scratch64[0] = x;
    let hi = scratch32[HI] as number;
    let e = 0;
    if (((hi >>> 20) & 0x7ff) === 0) {
        scratch64[0] = x * TWO54;
        hi = scratch32[HI] as number;
        e = -54;
    }
    e += ((hi >>> 20) & 0x7ff) - 1023;
    hi &= 0x000fffff;
    const around = (hi + 0x95f64) & 0x100000;
    scratch32[HI] = hi | (around ^ 0x3ff00000);
    e += around >>> 20;

    const f = scratch64[0] - 1;
    const s = f / (2 + f);
    const s2 = s * s;
    const s4 = s2 * s2;
    const t1 =
        s2 *
        (0.6666666666666735 +
            s4 * (0.2857142874366239 + s4 * (0.1818357216161805 + s4 * 0.14798198605116586)));
    const t2 = s4 * (0.3999999999940942 + s4 * (0.22222198432149784 + s4 * 0.15313837699209373));
    const R = t1 + t2;
    return e * LN2_HI - (s * (f - R) - e * LN2_LO - f);
}

export function pow(base: number, exponent: number): number {
    if (exponent === 0) return 1;
    if (exponent === 1) return base;
    if (base !== base || exponent !== exponent) return NaN;
    if (base === 1) return 1;
    if (base === 0) {
        if (exponent > 0) return 0;
        if (exponent < 0) return Infinity;
        return 1;
    }
    if (base === Infinity) return exponent > 0 ? Infinity : 0;
    if (base === -Infinity) {
        const oddInt = Number.isInteger(exponent) && exponent % 2 !== 0;
        if (exponent > 0) return oddInt ? -Infinity : Infinity;
        if (exponent < 0) return oddInt ? -0 : 0;
        return 1;
    }

    if (Number.isInteger(exponent) && Math.abs(exponent) < 53) {
        let result = 1;
        let n = Math.abs(exponent);
        let b = base;
        while (n > 0) {
            if (n & 1) result *= b;
            b *= b;
            n >>>= 1;
        }
        return exponent < 0 ? 1 / result : result;
    }

    if (base < 0 && !Number.isInteger(exponent)) return NaN;

    const sign = base < 0 && Number.isInteger(exponent) && exponent % 2 !== 0 ? -1 : 1;
    return sign * exp(exponent * log(Math.abs(base)));
}

export function expm1(x: number): number {
    if (Math.abs(x) < 1e-5) return x + 0.5 * x * x;
    return exp(x) - 1;
}

export function log1p(x: number): number {
    if (x === -1) return -Infinity;
    if (Math.abs(x) < 1e-4) return x * (1 - x * (0.5 - x / 3));
    return log(1 + x);
}

export function log2(x: number): number {
    return log(x) * INV_LN2;
}

export function log10(x: number): number {
    return log(x) * 0.4342944819032518;
}

export function sinh(x: number): number {
    if (Math.abs(x) < 1e-5) return x;
    const e = exp(x);
    return (e - 1 / e) * 0.5;
}

export function cosh(x: number): number {
    const e = exp(x);
    return (e + 1 / e) * 0.5;
}

export function tanh(x: number): number {
    if (x > 20) return 1;
    if (x < -20) return -1;
    // via expm1 to avoid the cancellation (e2−1)/(e2+1) suffers as e2→1 near x=0.
    const u = expm1(2 * x);
    return u / (u + 2);
}

export function asinh(x: number): number {
    if (x === Infinity || x === -Infinity) return x;
    return log(x + Math.sqrt(x * x + 1));
}

export function acosh(x: number): number {
    if (x < 1) return NaN;
    return log(x + Math.sqrt(x * x - 1));
}

export function atanh(x: number): number {
    if (x <= -1 || x >= 1) {
        return x === -1 ? -Infinity : x === 1 ? Infinity : NaN;
    }
    return 0.5 * log((1 + x) / (1 - x));
}

export function cbrt(x: number): number {
    if (x === 0 || x !== x) return x;
    const sign = x < 0 ? -1 : 1;
    return sign * pow(Math.abs(x), 1 / 3);
}

export function hypot(x: number, y: number): number {
    x = Math.abs(x);
    y = Math.abs(y);
    if (x === Infinity || y === Infinity) return Infinity;
    if (x !== x || y !== y) return NaN;
    if (x === 0) return y;
    if (y === 0) return x;
    // scale by the larger magnitude so x*x can't overflow when the true result fits.
    const m = Math.max(x, y);
    const r = Math.min(x, y) / m;
    return m * Math.sqrt(1 + r * r);
}
