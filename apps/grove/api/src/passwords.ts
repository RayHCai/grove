import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id at the library's own defaults — m=19456, t=2, p=1 — which are the OWASP-current
 * parameters. They are not passed explicitly because `Algorithm` is an ambient const enum that
 * `verbatimModuleSyntax` refuses to import, and the default is already argon2id.
 */
export async function hashPassword(password: string): Promise<string> {
    return hash(password);
}

/**
 * A real argon2id hash of nothing anyone knows, verified against whenever there is no stored hash to
 * verify against.
 *
 * Answering early when there is no hash to check — an address nobody holds, or an account whose
 * attempt was refused before it got this far — is what makes the response time say so, long before
 * any password is ever right.
 */
const ABSENT = hash('a password no account holds');

/** Constant enough in time that a wrong address and a wrong password cost the same. */
export async function verifyPassword(
    stored: string | undefined,
    presented: string,
): Promise<boolean> {
    const against = stored ?? (await ABSENT);
    // A stored value that is not a PHC string throws rather than returning false; the column has a
    // CHECK that refuses one, so treat a throw as "does not match" instead of a 500.
    const matched = await verify(against, presented).catch(() => false);
    return stored !== undefined && matched;
}
