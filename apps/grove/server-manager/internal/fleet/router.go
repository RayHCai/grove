// The whole of one join, once the line has reached it.

package fleet

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/contract"
)

// Router is the placement decision: rank what qualifies, commit one box, start the world if nothing
// is running it, and name the socket the player dials.
//
// One type rather than four loose dependencies, because the line in front of it must be able to
// hold the decision without holding a fleet.
type Router struct {
	Registry *Registry
	Balancer Balancer
	Ingress  Ingress
	// The box a reserved world is started on. One call, on the first join into a version of a game
	// and on no join after it.
	Agent Agent
	// How long one box may hold a start before this join gives up on it, which has to sit inside
	// the line's own deadline or it is a wait no join could ever finish.
	StartTimeout time.Duration
	Log          *slog.Logger
	// The clock the staleness window is measured against, so a test can age a box without waiting.
	Now func() time.Time
}

// Place answers one join, or false when nothing in the fleet qualifies.
func (r Router) Place(ctx context.Context, req contract.PlacementRequest) (contract.Placement, bool) {
	// Ranked outside the lock the decision below takes: a Balancer is handed a context because an
	// implementation may go and ask something, and no join may hold the fleet while it does.
	ordered := r.Balancer.Rank(ctx, req, r.Registry.Candidates(req.Region, r.Now()))

	placed, ok := r.Registry.Place(req, ordered, r.Now())
	if !ok {
		return contract.Placement{}, false
	}
	// Outside that lock, deliberately: this is a call to another machine, and the registry is what
	// every other join in the fleet is waiting on.
	if placed.Starts && !r.start(ctx, req, &placed) {
		return contract.Placement{}, false
	}

	return contract.Placement{
		HostID:     placed.Host.ID,
		InstanceID: placed.InstanceID,
		SessionID:  placed.SessionID,
		ServerURL:  r.Ingress.URL(placed.Host, placed),
		Revision:   placed.Revision,
	}, true
}

// start asks the chosen box to run the world this join reserved, and fills in the port it bound.
//
// A start that fails releases the reservation rather than leaving it: held, every later joiner for
// that version would be handed a session whose process nothing is ever going to spawn.
func (r Router) start(ctx context.Context, req contract.PlacementRequest, placed *Placement) bool {
	ctx, cancel := context.WithTimeout(ctx, r.StartTimeout)
	defer cancel()

	started, err := r.Agent.Start(ctx, placed.Host, contract.InstanceStart{
		InstanceID: placed.InstanceID,
		GameID:     req.GameID,
		SessionID:  placed.SessionID,
		Revision:   req.Revision,
		Bundles:    req.Bundles,
	})
	if err != nil {
		r.Registry.Release(req.GameID, placed.SessionID)
		// A box that filled is the fleet being busy and not a fault, so it is logged as the one
		// and not the other — an operator paging on every full box would page on every full fleet.
		if errors.Is(err, ErrHostFull) {
			r.Log.InfoContext(ctx, "the chosen box was full",
				"hostId", placed.Host.ID, "gameId", req.GameID, "revision", req.Revision)
			return false
		}
		r.Log.ErrorContext(ctx, "start a world",
			"err", err, "hostId", placed.Host.ID, "gameId", req.GameID, "revision", req.Revision)
		return false
	}

	// The box's own ids, never the ones asked for: a box that answered about another instance is
	// one whose port belongs to another world, and sending a player there is worse than refusing.
	if started.InstanceID != placed.InstanceID || started.SessionID != placed.SessionID {
		r.Registry.Release(req.GameID, placed.SessionID)
		r.Log.ErrorContext(ctx, "the box started another session",
			"hostId", placed.Host.ID, "asked", placed.SessionID, "answered", started.SessionID)
		return false
	}

	placed.Port = started.Port
	r.Registry.Started(req.GameID, req.Revision, placed.SessionID, started.Port)
	return true
}

// Release hands back the slot a placement took, for a caller that had already stopped waiting.
func (r Router) Release(gameID, sessionID string) { r.Registry.Release(gameID, sessionID) }
