# @grove/player

The game surface: a client, its socket, and a renderer, mounted as one component.

It holds no authority and validates nothing. Every boundary that matters — admission, request
checking, ticket verification — belongs to the authority it connects to. Depends on engine packages
only, so it can be mounted by the editor and by the player origin alike.
