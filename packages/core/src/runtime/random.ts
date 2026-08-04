import type { Vec3 } from '@platform/math';

export interface Random {
    seed(n: number): void;
    between(min: number, max: number): number;
    pick<T>(list: T[]): T;
    chance(probability: number): boolean;
    pointIn(region: string): Vec3;
}

export const random: Random = null!;
