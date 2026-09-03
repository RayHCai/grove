# @grove/server-manager

The agent on one fleet host.

Spawns a game process per session, caps its memory and CPU, reaps it, and reports this host's
capacity upward. It allocates nothing: which host a session lands on is the API's decision.
