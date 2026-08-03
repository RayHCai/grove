// Vectors. `Vec3` is fully populated and is what every function returns; `Vec3Like`
// permits an omitted `z` and is what every parameter accepts (§2 of the renderer design).

/** A point or direction. All three axes present. Matches api_spec.ts:48. */
export interface Vec3 {
    x: number;
    y: number;
    z: number;
}

/** Parameter form of {@link Vec3}: `z` defaults to 0 at every call site that reads it. */
export interface Vec3Like {
    x: number;
    y: number;
    z?: number;
}

/** A fresh vector. The only allocating helper here — the rest take an `out`. */
export function vec3(x = 0, y = 0, z = 0): Vec3 {
    return { x, y, z };
}

/** Writes `x`/`y`/`z` into `out` and returns it. Allocation-free. */
export function vec3Set(out: Vec3, x: number, y: number, z = 0): Vec3 {
    out.x = x;
    out.y = y;
    out.z = z;
    return out;
}

/** Copies `src` into `out`, filling an omitted `src.z` with 0. Allocation-free. */
export function vec3Copy(out: Vec3, src: Vec3Like): Vec3 {
    out.x = src.x;
    out.y = src.y;
    out.z = src.z ?? 0;
    return out;
}

/** `src.z` with the documented default applied. */
export function vec3Z(src: Vec3Like): number {
    return src.z ?? 0;
}
