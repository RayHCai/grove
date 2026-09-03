# @grove/game-instance

One game session, in one process: the server glue and the creator code it runs.

The process boundary is the isolation. It runs a creator's `ServerScript`, which is ordinary Node
code — so it holds no database credential, no platform secret, and nothing another session owns.
