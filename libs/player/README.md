# @grove/player

The game surface: the canvas a session mounts onto, addressed at the authority that runs it.

It holds no authority and validates nothing. Every boundary that matters — admission, request
checking, ticket verification — belongs to the authority a session is addressed at. Depends on
engine packages only, so it can be mounted by the editor and by the player origin alike.
