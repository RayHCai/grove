// The Go half of the fleet, as one module. The three services and the library they share are
// checked out together and released together, so a module boundary between them would buy an
// independent version each and cost a `replace` or a proxy round trip to resolve it.

module github.com/RayHCai/grove

go 1.24

// Pinned newer than the go line, which stays a language floor: 1.24 is out of support and most
// stdlib advisories against it were never backported, while a floor is what still builds under
// GOTOOLCHAIN=local on a machine that cannot download this one.
toolchain go1.26.8
