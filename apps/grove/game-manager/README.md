# @grove/game-manager

Game data for running sessions: `@serverState`, leaderboards, and the bundles a session loads.

The only thing between a game process and the database. A game process holds no database credential
and presents a session-scoped token, so a request can only reach the keys its own game owns. Not
publicly routable.
