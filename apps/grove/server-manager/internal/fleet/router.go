// The whole of one join, once the line has reached it.

package fleet

import (
	"context"
	"crypto/ed25519"
	"errors"
	"log/slog"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/RayHCai/grove/apps/grove/server-manager/internal/joins"
	"github.com/RayHCai/grove/libs/go-grove/contract"
	"github.com/RayHCai/grove/libs/go-grove/token"
)

// StoreTokenLifetime is how long a world's store bearer lives, and so the longest a world can run.
const StoreTokenLifetime = 12 * time.Hour

// How long a stop of a world nobody is waiting for may take, being a drain that writes its saves.
const orphanStopTimeout = 45 * time.Second

// Router is the placement decision: rank what qualifies, commit one box, start the world if nothing
// is running it, and name the socket the player dials.
type Router struct {
	Registry *Registry
	Balancer Balancer
	Ingress  Ingress
	// The box a reserved world is started on, and stopped on when nobody waited for the start.
	Agent Agent
	// Signs each world's store bearer; the boxes hold no key that could.
	StoreKey ed25519.PrivateKey
	// How long one box may hold a start before the join moves to the next one.
	StartTimeout time.Duration
	// How long a box whose start failed is routed around.
	SuspectFor time.Duration
	Log        *slog.Logger
	// The clock the staleness window is measured against, so a test can age a box without waiting.
	Now func() time.Time

	mu      sync.Mutex
	flights map[world]*flight
}

// flight is one world being started, which every join for that world waits on rather than racing.
type flight struct {
	done chan struct{}
	// Written once, before done closes.
	placed contract.Placement
	ok     bool
	// Joins still waiting, so a start that lands after all of them have gone is stopped.
	waiting atomic.Int32
}

// Decide answers one join from what the registry holds, without leaving the process: a running
// world, a start in flight to wait on, or a start this join now owes.
func (r *Router) Decide(ctx context.Context, req contract.PlacementRequest) joins.Decision {
	key := world{gameID: req.GameID, revision: req.Revision}

	if f := r.attach(key); f != nil {
		return joins.Decision{Finish: func(ctx context.Context) (contract.Placement, bool) {
			return r.await(ctx, f)
		}}
	}

	// Ranked outside the registry's lock: a Balancer is handed a context because an implementation
	// may go and ask something, and no join may hold the fleet while it does.
	ordered := r.Balancer.Rank(ctx, req, r.Registry.Candidates(req.Region, r.Now()))
	placed, ok := r.Registry.Place(req, ordered, r.Now())
	if !ok {
		return joins.Decision{}
	}
	if !placed.Starts {
		return joins.Decision{Placement: r.placement(placed), Placed: true}
	}

	f := r.fly(key)
	return joins.Decision{Start: true, Finish: func(ctx context.Context) (contract.Placement, bool) {
		landed, ok := r.start(ctx, req, placed, ordered)
		return r.land(key, f, landed, ok, ctx.Err() != nil)
	}}
}

// start runs the world on the box the join reserved, and on the next ranked box while the join's
// budget lasts; a box that failed for any reason but being full is routed around for SuspectFor.
func (r *Router) start(ctx context.Context, req contract.PlacementRequest, placed Placement, ordered []Host) (Placement, bool) {
	tried := make(map[string]bool, len(ordered))
	for {
		err := r.startOn(ctx, req, &placed)
		if err == nil {
			return placed, true
		}
		r.Registry.Release(req.GameID, placed.SessionID)
		tried[placed.Host.ID] = true
		r.blame(ctx, req, placed.Host, err)
		if ctx.Err() != nil {
			return Placement{}, false
		}

		next := slices.DeleteFunc(slices.Clone(ordered), func(h Host) bool { return tried[h.ID] })
		var ok bool
		if placed, ok = r.Registry.Place(req, next, r.Now()); !ok {
			return Placement{}, false
		}
		// A beat since the failure may have named a running world, which is an answer in itself.
		if !placed.Starts {
			return placed, true
		}
	}
}

// startOn makes one attempt, inside StartTimeout and the join's own budget, filling in the port.
func (r *Router) startOn(ctx context.Context, req contract.PlacementRequest, placed *Placement) error {
	expires := r.Now().Add(StoreTokenLifetime)
	bearer, err := token.Sign(token.Claims{
		GameID:    req.GameID,
		SessionID: placed.SessionID,
		Aud:       token.AudGameManager,
		Exp:       expires.Unix(),
	}, r.StoreKey)
	if err != nil {
		return errNotTheBox{err}
	}

	ctx, cancel := context.WithTimeout(ctx, r.StartTimeout)
	defer cancel()

	started, err := r.Agent.Start(ctx, placed.Host, contract.InstanceStart{
		InstanceID:          placed.InstanceID,
		GameID:              req.GameID,
		SessionID:           placed.SessionID,
		Revision:            req.Revision,
		Bundles:             req.Bundles,
		StoreToken:          bearer,
		StoreTokenExpiresAt: contract.Timestamp(expires),
	})
	if err != nil {
		return err
	}
	// The box's own ids, never the ones asked for: a box that answered about another instance is
	// one whose port belongs to another world, and sending a player there is worse than refusing.
	if started.InstanceID != placed.InstanceID || started.SessionID != placed.SessionID {
		return errors.New("the box started another session")
	}

	placed.Port = started.Port
	r.Registry.Started(req.GameID, req.Revision, placed.SessionID, started.Port)
	return nil
}

// blame records what a failed start says about the box. Full is the fleet being busy, and a budget
// that ran out is this join's clock rather than the box's fault, so neither suspects it.
func (r *Router) blame(ctx context.Context, req contract.PlacementRequest, h Host, err error) {
	var ours errNotTheBox
	switch {
	case errors.Is(err, ErrHostFull):
		r.Log.InfoContext(ctx, "the chosen box was full", "hostId", h.ID, "gameId", req.GameID)
	case errors.As(err, &ours), ctx.Err() != nil, errors.Is(err, context.DeadlineExceeded):
		r.Log.WarnContext(ctx, "start a world", "err", err, "hostId", h.ID, "gameId", req.GameID)
	default:
		r.Log.ErrorContext(ctx, "start a world", "err", err, "hostId", h.ID, "gameId", req.GameID)
		r.Registry.Suspect(h.ID, "start failed: "+err.Error(), r.Now(), r.SuspectFor)
	}
}

// land answers everyone waiting on a start, and stops a world that came up after all of them left.
func (r *Router) land(key world, f *flight, placed Placement, ok, starterGone bool) (contract.Placement, bool) {
	// Under the lock a join attaches under, so no waiter can arrive between the count and the stop.
	r.mu.Lock()
	delete(r.flights, key)
	orphan := ok && placed.Starts && starterGone && f.waiting.Load() == 0
	r.mu.Unlock()

	if ok && !orphan {
		f.placed, f.ok = r.placement(placed), true
	}
	close(f.done)

	if orphan {
		r.Registry.Release(key.gameID, placed.SessionID)
		go r.stopOrphan(placed.Host, placed.InstanceID)
	}
	return f.placed, f.ok
}

func (r *Router) await(ctx context.Context, f *flight) (contract.Placement, bool) {
	defer f.waiting.Add(-1)
	select {
	case <-f.done:
		return f.placed, f.ok
	case <-ctx.Done():
		return contract.Placement{}, false
	}
}

// stopOrphan ends a world nobody will be told about, off every join's clock.
func (r *Router) stopOrphan(h Host, instanceID string) {
	ctx, cancel := context.WithTimeout(context.Background(), orphanStopTimeout)
	defer cancel()
	if err := r.Agent.Stop(ctx, h, instanceID); err != nil {
		// The box's idle reap ends it in minutes, so a failed stop costs a slot and not the world.
		r.Log.Warn("stop a world nobody waited for", "err", err, "hostId", h.ID, "instanceId", instanceID)
	}
}

func (r *Router) placement(p Placement) contract.Placement {
	return contract.Placement{
		HostID:     p.Host.ID,
		InstanceID: p.InstanceID,
		SessionID:  p.SessionID,
		ServerURL:  r.Ingress.URL(p.Host, p),
		Revision:   p.Revision,
	}
}

// attach joins the world's start in flight, if there is one, as one more join waiting on it.
func (r *Router) attach(key world) *flight {
	r.mu.Lock()
	defer r.mu.Unlock()
	f := r.flights[key]
	if f != nil {
		f.waiting.Add(1)
	}
	return f
}

func (r *Router) fly(key world) *flight {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.flights == nil {
		r.flights = make(map[world]*flight)
	}
	f := &flight{done: make(chan struct{})}
	r.flights[key] = f
	return f
}

// errNotTheBox is a start that failed on this side of the call, which says nothing about the box.
type errNotTheBox struct{ err error }

func (e errNotTheBox) Error() string { return e.err.Error() }
func (e errNotTheBox) Unwrap() error { return e.err }
