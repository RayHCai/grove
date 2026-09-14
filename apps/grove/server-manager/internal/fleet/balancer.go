// The one policy this service exists to hold: which box takes the next session.

package fleet

import (
	"cmp"
	"context"
	"slices"
	"strings"

	"github.com/RayHCai/grove/libs/go-grove/contract"
)

// Balancer orders the boxes that already qualify — the caller has filtered for freshness, capacity
// and region, so an implementation only ranks.
//
// An interface because ranking is what a real fleet changes: spot-interruption risk, price per
// region, whether a box has already pulled the game's bundles.
type Balancer interface {
	// The whole order rather than one winner, because the box ranked first may have filled between
	// the ranking and the placement, and that join takes the next box rather than failing.
	Rank(ctx context.Context, req contract.PlacementRequest, hosts []Host) []Host
}

// MostFree fills the emptiest box first, which keeps the fleet's headroom pooled on a few boxes
// rather than spread a slot at a time across all of them, where nothing large can land.
type MostFree struct{}

func (MostFree) Rank(_ context.Context, _ contract.PlacementRequest, hosts []Host) []Host {
	// Cloned rather than sorted in place, since the order a caller handed over is the caller's.
	ordered := slices.Clone(hosts)
	slices.SortFunc(ordered, emptiestFirst)
	return ordered
}

// A tie breaks on the lower hostId, never on map or slice order: two identical requests that ranked
// equal must land on the same box, or one game's players scatter across the fleet a join at a time.
func emptiestFirst(a, b Host) int {
	if a.FreeSlots() != b.FreeSlots() {
		return cmp.Compare(b.FreeSlots(), a.FreeSlots())
	}
	return strings.Compare(a.ID, b.ID)
}
