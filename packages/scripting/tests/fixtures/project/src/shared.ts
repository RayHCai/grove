/** Both halves compile against this, and it declares no script — the linker's shared module. */
export const SPEED = 4;

export function drift(x: number, dt: number): number {
    return x + SPEED * dt;
}
