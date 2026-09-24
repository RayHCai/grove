/**
 * The reference stage every Grove game is authored against, in world px.
 *
 * One number the whole platform shares rather than one each surface guesses at: the editor's
 * preview and the player origin must size their stage identically, or a widget a creator placed
 * against one lands somewhere else in the other. It is not a project setting yet — when a build
 * publishes a project's own, `GamePlayer`'s `design` prop is where it arrives.
 */
export const DESIGN_STAGE: { readonly width: number; readonly height: number } = {
    width: 960,
    height: 540,
};
