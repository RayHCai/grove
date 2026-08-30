// MutableVec3 is assignable to Vec3, so engine code that produces a vector returns the readonly
// type without a cast; only code that writes needs the mutable one.

/** A point or direction. Readonly, so `entity.position.x = 5` is a compile error. */
export interface Vec3 {
    readonly x: number;
    readonly y: number;
    readonly z: number;
}

/** A writable vector. Internal to engine packages; out-param helpers operate on this. */
export interface MutableVec3 {
    x: number;
    y: number;
    z: number;
}

/** Parameter form of {@link Vec3}: `z` defaults to 0 at every call site that reads it. */
export interface Vec3Like {
    readonly x: number;
    readonly y: number;
    readonly z?: number;
}

/** A fresh mutable vector. The only allocating helper here — the rest take an `out`. */
export function vec3(x = 0, y = 0, z = 0): MutableVec3 {
    return { x, y, z };
}

/** Writes `x`/`y`/`z` into `out` and returns it. Allocation-free. */
export function vec3Set(out: MutableVec3, x: number, y: number, z = 0): MutableVec3 {
    out.x = x;
    out.y = y;
    out.z = z;
    return out;
}

/** Copies `src` into `out`, filling an omitted `src.z` with 0. Allocation-free. */
export function vec3Copy(out: MutableVec3, src: Vec3Like): MutableVec3 {
    out.x = src.x;
    out.y = src.y;
    out.z = src.z ?? 0;
    return out;
}

/** Euclidean length of a vector. */
export function vec3Length(v: Vec3Like): number {
    const x = v.x;
    const y = v.y;
    const z = v.z ?? 0;
    return Math.sqrt(x * x + y * y + z * z);
}

/** Squared length — avoids the sqrt when only comparing magnitudes. */
export function vec3LengthSq(v: Vec3Like): number {
    const x = v.x;
    const y = v.y;
    const z = v.z ?? 0;
    return x * x + y * y + z * z;
}

/** Distance in the xy plane. `z` is deliberately ignored, unlike {@link vec3Length}. */
export function vec3Dist2D(a: Vec3Like, b: Vec3Like): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return Math.sqrt(dx * dx + dy * dy);
}

/** Normalizes `v` into `out`. Zero-length vectors produce (0,0,0). */
export function vec3Normalize(out: MutableVec3, v: Vec3Like): MutableVec3 {
    const len = vec3Length(v);
    if (len === 0) {
        out.x = 0;
        out.y = 0;
        out.z = 0;
    } else {
        const inv = 1 / len;
        out.x = v.x * inv;
        out.y = v.y * inv;
        out.z = (v.z ?? 0) * inv;
    }
    return out;
}
