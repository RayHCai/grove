// The whole of a new game: a body that walks, and the rule that gives everybody one. Nothing is
// imported — every name below is the engine, and the editor supplies the imports when it compiles
// this.

/** The body: a walker seen from above, at the pace these two numbers set. */
export class Walk extends TopDownMovement {
    /** How fast a held direction takes you, in world units per second. */
    override walkSpeed = 180;
    /** The ceiling nothing else may push you past. */
    override maxSpeed = 320;
}

/** The rules of the game. Server-side, because who has a body is the world's to decide. */
export class Rules extends ServerScript<Game> {
    @onPlayerJoin
    welcome(ctx: Ctx): void {
        const player = ctx.player;
        if (!player) return;
        player.spawn();
        player.setMovement(Walk);
    }
}
