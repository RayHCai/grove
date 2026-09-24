/** Joins the class names that are set, skipping the falsy ones a conditional leaves behind. */
export function cx(...parts: Array<string | false | null | undefined>): string {
    return parts
        .filter((part): part is string => typeof part === 'string' && part !== '')
        .join(' ');
}
