// The weapon table. Data, not behavior — the server fires from it and the hotbar
// draws from it, so it belongs beside neither.

export const SLOTS = ['pea-shooter', 'scatter-pod', 'thorn-cannon'] as const;
export type WeaponKey = (typeof SLOTS)[number];

export interface Weapon {
    label: string;
    icon: string;
    sound: string;
    damage: number;
    pellets: number; // 1, or a fan `spread` degrees wide
    spread: number;
    range: number;
    cooldown: number;
    clip: number; // ammo one crate gives
}

export const WEAPONS: Record<WeaponKey, Weapon> = {
    'pea-shooter': {
        label: 'Pea Shooter',
        icon: 'icon-pea',
        sound: 'shot-pea',
        damage: 1,
        pellets: 1,
        spread: 0,
        range: 420,
        cooldown: 0.18,
        clip: 24,
    },
    'scatter-pod': {
        label: 'Scatter Pod',
        icon: 'icon-scatter',
        sound: 'shot-scatter',
        damage: 1,
        pellets: 3,
        spread: 14,
        range: 240,
        cooldown: 0.7,
        clip: 12,
    },
    'thorn-cannon': {
        label: 'Thorn Cannon',
        icon: 'icon-thorn',
        sound: 'shot-thorn',
        damage: 3,
        pellets: 1,
        spread: 0,
        range: 620,
        cooldown: 1.1,
        clip: 5,
    },
};

export const EMPTY: Record<WeaponKey, number> = {
    'pea-shooter': 0,
    'scatter-pod': 0,
    'thorn-cannon': 0,
};

export const isWeapon = (key: unknown): key is WeaponKey => SLOTS.includes(key as WeaponKey);
