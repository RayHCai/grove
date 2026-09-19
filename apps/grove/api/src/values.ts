import { z } from 'zod';

/**
 * The field shapes the account and game routes share.
 *
 * One definition per field rather than one per route: a password policy spelled at sign-up and
 * forgotten at password-change is a policy the second route lets a caller downgrade past.
 */

// Control, format, line and paragraph separators. `Cf` is the one that matters most: it holds the
// bidi overrides that let a name render as something other than what it is, and this service hands
// `displayName` to creator-authored game code through every leaderboard row.
const UNRENDERABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Folded on the way in, because the account holding an address has to be exactly one row. */
export const Email = z
    .email()
    .max(254)
    .transform((raw) => raw.trim().toLowerCase());

export const Password = z.string().min(12).max(128);

export const DisplayName = z
    .string()
    .max(256)
    .transform((raw) => raw.normalize('NFKC').trim())
    .refine((name) => name.length >= 1 && name.length <= 64, {
        message: 'display name is 1 to 64 characters once trimmed',
    })
    .refine((name) => !UNRENDERABLE.test(name), {
        message: 'display name cannot carry control or direction-override characters',
    });

export const GameTitle = z
    .string()
    .max(512)
    .transform((raw) => raw.normalize('NFKC').trim())
    .refine((title) => title.length >= 1 && title.length <= 120, {
        message: 'title is 1 to 120 characters once trimmed',
    })
    .refine((title) => !UNRENDERABLE.test(title), {
        message: 'title cannot carry control or direction-override characters',
    });

/** The read side of the same fold `Email` applies, for a value that is not a request body. */
export function foldEmail(raw: string): string {
    return raw.trim().toLowerCase();
}
