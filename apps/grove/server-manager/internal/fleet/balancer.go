// The one policy this service exists to hold: which box takes the next session.

package fleet

import (
	"context"

	"github.com/RayHCai/grove/libs/go-grove/contract"
)

// Balancer chooses among boxes that already qualify — the caller has filtered for freshness,
// capacity and region, so an implementation only ranks.
//
// An interface because ranking is what a real fleet changes: spot-interruption risk, price per
// region, whether a box has already pulled the game's bundles.
type Balancer interface {
	Pick(ctx context.Context, req contract.PlacementRequest, hosts []Host) (Host, bool)
}

// MostFree fills the emptiest box first, which keeps the fleet's headroom pooled on a few boxes
// rather than spread a slot at a time across all of them, where nothing large can land.
type MostFree struct{}

func (MostFree) Pick(_ context.Context, _ contract.PlacementRequest, hosts []Host) (Host, bool) {
	var best Host
	found := false

	for _, h := range hosts {
		if !found || ranksAbove(h, best) {
			best, found = h, true
		}
	}
	return best, found
}

// A tie breaks on the lower hostId, never on map or slice order: two identical requests that ranked
// equal must land on the same box, or one game's players scatter across the fleet a join at a time.
func ranksAbove(a, b Host) bool {
	if a.FreeSlots() != b.FreeSlots() {
		return a.FreeSlots() > b.FreeSlots()
	}
	return a.ID < b.ID
}
