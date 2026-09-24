/**
 * The floor and ceiling every account's password is held to.
 *
 * Declared here rather than at the route, because the form that states the rule to a person and
 * the schema that enforces it are in different packages and must agree.
 */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
