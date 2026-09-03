# @grove/api

The public API: accounts, projects, social, and the allocator that mints join tickets.

The only service a browser talks to over HTTP. It never sits on a per-tick path — a client dials its
game process directly, with a ticket this service signed.
