// Deterministic replacements for the ECMA-262 implementation-approximated functions.
// Two machines must produce identical results from identical inputs; the built-in
// transcendentals do not guarantee that (DESIGN §9.1). These implementations use
// polynomial/range-reduction over exact IEEE-754 operations, producing bit-identical
// results everywhere.
//
// The six load-bearing functions — sin, cos, atan2, pow, exp, log — are implemented
// carefully. The rest are derived from them by identity.
//
// SAFE SET (not replaced): abs, sign, min, max, floor, ceil, round, trunc, fround, sqrt.
// Those are exact IEEE-754 operations and agree bit-for-bit on every target.

const PI = 3.141592653589793;
const HALF_PI = 1.5707963267948966;
const TWO_PI = 6.283185307179586;
const INV_TWO_PI = 0.15915494309189535;

// ─── sin / cos ──────────────────────────────────────────────────────────────────

function reduceAngle(x: number): number {
    const q = Math.round(x * INV_TWO_PI);
    let reduced = x - q * TWO_PI;
    if (reduced > PI) reduced -= TWO_PI;
    else if (reduced < -PI) reduced += TWO_PI;
    // sin(π−r) = sin(−π−r) = sin(r): reflecting into [−π/2, π/2] preserves sine, so no sign flip.
    if (reduced < -HALF_PI) reduced = -PI - reduced;
    else if (reduced > HALF_PI) reduced = PI - reduced;
    return reduced;
}

function sinKernel(x: number): number {
    const x2 = x * x;
    const c5 = -0.000000025050747879607072;
    const c4 = 0.0000027557315514280769 + x2 * c5;
    const c3 = -0.00019841269836761127 + x2 * c4;
    const c2 = 0.008333333333332249 + x2 * c3;
    const c1 = -0.16666666666666632 + x2 * c2;
    return x * (1 + x2 * c1);
}

export function sin(x: number): number {
    if (x !== x) return NaN;
    if (!isFinite(x)) return NaN;
    if (x === 0) return x;
    return sinKernel(reduceAngle(x));
}

export function cos(x: number): number {
    if (x !== x) return NaN;
    if (!isFinite(x)) return NaN;
    return sin(x + HALF_PI);
}

export function tan(x: number): number {
    const c = cos(x);
    if (c === 0) return x > 0 ? Infinity : -Infinity;
    return sin(x) / c;
}

// ─── atan / atan2 ────────────────────────────────────────────────────────────────

function atanKernel(x: number): number {
    const x2 = x * x;
    const x4 = x2 * x2;
    const s1 = -0.3333333333331711 + x2 * 0.19999999999874913;
    const s2 = -0.14285714266771338 + x2 * 0.11111110678749424;
    const s3 = -0.0909090442773387 + x2 * 0.07692307001993961;
    const s4 = -0.06666652376498812 + x2 * 0.058823529365552845;
    const s5 = -0.049999810939498;
    const poly = s1 + x4 * (s2 + x4 * (s3 + x4 * (s4 + x4 * s5)));
    return x * (1 + x2 * poly);
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

// ─── exp / log ──────────────────────────────────────────────────────────────────

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

// ─── pow ─────────────────────────────────────────────────────────────────────────

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

// ─── derived functions ───────────────────────────────────────────────────────────

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
