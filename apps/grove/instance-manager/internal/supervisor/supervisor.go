// Package supervisor is every game process on this box: what is running, what each one is doing,
// and what each one last said.
package supervisor

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/contract"
	"github.com/RayHCai/grove/libs/go-grove/token"
)

var (
	// ErrAtCapacity is the 409: this box is full, and which box a session lands on is
	// @grove/server-manager's to decide again.
	ErrAtCapacity = errors.New("host is at its instance cap")
	// ErrUnknown is the 404.
	ErrUnknown = errors.New("no such instance")
)

// What a child is given when this agent has no narrower answer, matching the game process's own
// defaults so the two halves never disagree about a limit.
const (
	defaultHeapLimitBytes = 256 * 1024 * 1024
	defaultTickBudget     = 250 * time.Millisecond
	defaultLogLines       = 512
	defaultStartGrace     = 20 * time.Second
	defaultStopTimeout    = 20 * time.Second
	defaultRetention      = 10 * time.Minute
)

// How long the bearer this agent mints for a child is good for. Sized to the longest session this
// box will hold rather than to a join ticket: a world that outlives its store credential loses
// every save it had left, and there is no revocation behind this but the expiry.
const storeBearerLifetime = 12 * time.Hour

// Options is the whole configuration of a Registry, seams included.
type Options struct {
	Launcher Launcher
	Prober   Prober
	Ports    Ports
	Log      *slog.Logger

	MaxInstances int
	// Lines of a child's output kept per instance.
	LogLines int
	// How long a child may take to bind its port before a failed probe means unhealthy.
	StartGrace time.Duration
	// How long a drain may take before the process is taken anyway.
	StopTimeout time.Duration
	// How long a reaped instance stays listed, since its last lines are the account of why it ended.
	Retention time.Duration
	// Where the children this box started are written down, so the next run of this agent finds
	// the ones this one left running.
	StateDir string

	TokenSecret    []byte
	HeapLimitBytes int64
	TickBudget     time.Duration
}

// Request is one session this box was told to run.
type Request struct {
	// Chosen by @grove/server-manager, which hands it to the player in the same breath: a second id
	// minted here would name a process nobody was told to dial.
	InstanceID    string
	GameID        string
	SessionID     string
	BundlePath    string
	SimConfigPath string
	ManagerURL    string
}

// View is what this box reports about one game process.
type View struct {
	contract.InstanceReport
}

type instance struct {
	id        string
	gameID    string
	sessionID string
	port      int
	addr      string
	startedAt time.Time
	child     Child
	logs      *Ring
	ended     chan struct{}
	stopOnce  sync.Once

	mu      sync.Mutex
	state   contract.InstanceState
	players int
	exited  bool
	endedAt time.Time
}

// Registry holds one entry per game process this box started.
type Registry struct {
	opts  Options
	state store

	mu        sync.Mutex
	instances map[string]*instance
}

// New builds the registry the routes and the heartbeat both read.
func New(opts Options) *Registry {
	if opts.LogLines < 1 {
		opts.LogLines = defaultLogLines
	}
	if opts.StartGrace <= 0 {
		opts.StartGrace = defaultStartGrace
	}
	if opts.StopTimeout <= 0 {
		opts.StopTimeout = defaultStopTimeout
	}
	if opts.Retention <= 0 {
		opts.Retention = defaultRetention
	}
	if opts.HeapLimitBytes <= 0 {
		opts.HeapLimitBytes = defaultHeapLimitBytes
	}
	if opts.TickBudget <= 0 {
		opts.TickBudget = defaultTickBudget
	}
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	return &Registry{
		opts:      opts,
		state:     store{dir: opts.StateDir},
		instances: make(map[string]*instance),
	}
}

// Start spawns one game process and returns what this box will report about it.
func (r *Registry) Start(ctx context.Context, req Request) (View, error) {
	// Held across the spawn so the cap is a real cap: two concurrent starts must not both pass it.
	r.mu.Lock()
	defer r.mu.Unlock()

	// One session, one world. A retried start — a @grove/server-manager timeout, a duplicated
	// request — must be handed the process already holding the session, because a second one beside
	// it is a second world that half the players would be talking to.
	for _, held := range r.instances {
		if held.sessionID == req.SessionID && !held.done() {
			return held.view(time.Now()), nil
		}
	}

	if r.running() >= r.opts.MaxInstances {
		return View{}, ErrAtCapacity
	}

	id := req.InstanceID
	// Minted here rather than carried in: nothing upstream holds GAME_TOKEN_SECRET on the placement
	// path, and a credential that never crosses the fleet network cannot be read off it.
	bearer, err := token.Sign(token.Claims{
		GameID:    req.GameID,
		SessionID: req.SessionID,
		Aud:       token.AudGameManager,
		Exp:       time.Now().Add(storeBearerLifetime).Unix(),
	}, r.opts.TokenSecret)
	if err != nil {
		return View{}, fmt.Errorf("mint the store bearer: %w", err)
	}

	port, err := r.opts.Ports.Take()
	if err != nil {
		return View{}, err
	}

	logs := NewRing(r.opts.LogLines)
	child, err := r.opts.Launcher.Start(ctx, Spec{
		GameID:    req.GameID,
		SessionID: req.SessionID,
		// Bound on every interface because a player dials the box directly; the probe still reaches
		// it over loopback, which is the only path this agent uses.
		Bind:           fmt.Sprintf("0.0.0.0:%d", port),
		BundlePath:     req.BundlePath,
		SimConfigPath:  req.SimConfigPath,
		TokenSecret:    r.opts.TokenSecret,
		ManagerURL:     req.ManagerURL,
		ManagerToken:   bearer,
		HeapLimitBytes: r.opts.HeapLimitBytes,
		TickBudget:     r.opts.TickBudget,
	}, logs)
	if err != nil {
		// Nothing else will hand this one back: no process holds it, and no entry names it.
		r.opts.Ports.Release(port)
		return View{}, fmt.Errorf("spawn a game process: %w", err)
	}

	inst := &instance{
		id:        id,
		gameID:    req.GameID,
		sessionID: req.SessionID,
		port:      port,
		addr:      fmt.Sprintf("127.0.0.1:%d", port),
		startedAt: time.Now(),
		child:     child,
		logs:      logs,
		ended:     make(chan struct{}),
		state:     contract.InstanceStarting,
	}
	r.instances[id] = inst

	// Written down before anything can reap it, so the record of a child that ends at once is
	// dropped rather than left naming a pid this box no longer has.
	if err := r.state.put(record{
		InstanceID: id,
		GameID:     req.GameID,
		SessionID:  req.SessionID,
		PID:        child.Pid(),
		Port:       port,
		StartedAt:  inst.startedAt,
	}); err != nil {
		// The session runs either way; all a box that cannot write this down loses is the process
		// itself, on its next restart.
		r.opts.Log.Warn("instance not written down", "instanceId", id, "err", err)
	}
	go r.reap(inst)

	r.opts.Log.Info("instance started",
		"instanceId", id, "gameId", req.GameID, "sessionId", req.SessionID, "port", port)
	return inst.view(time.Now()), nil
}

// reap waits for a child to exit and records how it went.
//
// Nothing is restarted here: a game-instance that died took its world with it, and a restart would
// hand its players a world that never existed.
func (r *Registry) reap(inst *instance) {
	err := inst.child.Wait()

	inst.mu.Lock()
	inst.exited = true
	inst.endedAt = time.Now()
	inst.state = contract.InstanceUnhealthy
	inst.mu.Unlock()
	close(inst.ended)

	// Both belong to the process that just ended: the port it held is free again, and the record
	// naming it has nothing left to adopt.
	r.opts.Ports.Release(inst.port)
	if err := r.state.drop(inst.id); err != nil {
		r.opts.Log.Warn("instance not forgotten", "instanceId", inst.id, "err", err)
	}

	if err != nil {
		inst.logs.Add("game-instance exited: " + err.Error())
	} else {
		inst.logs.Add("game-instance exited cleanly")
	}
	r.opts.Log.Info("instance exited", "instanceId", inst.id, "sessionId", inst.sessionID, "err", err)
}

// Adopt takes back the children an earlier run of this agent left running, and forgets the records
// of those that have since ended.
//
// A redeploy deliberately outlives its children, so an agent that came back without looking for
// them would double-book the box and leave a session in progress unroutable.
func (r *Registry) Adopt() error {
	held, err := r.state.all()
	if err != nil {
		return err
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	for _, rec := range held {
		child, err := r.opts.Launcher.Adopt(rec.PID)
		if err != nil && !errors.Is(err, ErrNotOurs) {
			// A read this agent could not make says nothing about the process, so the record stays
			// for the next boot to retry and its port stays held against whatever still holds it.
			r.opts.Ports.Hold(rec.Port)
			r.opts.Log.Warn("instance neither adopted nor forgotten",
				"instanceId", rec.InstanceID, "pid", rec.PID, "err", err)
			continue
		}
		if err != nil {
			r.opts.Log.Info("instance not adopted",
				"instanceId", rec.InstanceID, "pid", rec.PID, "err", err)
			if err := r.state.drop(rec.InstanceID); err != nil {
				r.opts.Log.Warn("instance not forgotten", "instanceId", rec.InstanceID, "err", err)
			}
			continue
		}

		// The survivor holds this port whether or not it has bound it yet, and nothing else would
		// tell this agent that: an empty issued set is a number the next start may be handed.
		r.opts.Ports.Hold(rec.Port)

		inst := &instance{
			id:        rec.InstanceID,
			gameID:    rec.GameID,
			sessionID: rec.SessionID,
			port:      rec.Port,
			addr:      fmt.Sprintf("127.0.0.1:%d", rec.Port),
			// The recorded start, so a survivor of a boot that finished long ago is read against a
			// grace it has already spent rather than given a fresh one.
			startedAt: rec.StartedAt,
			child:     child,
			// Its output went to a pipe that died with the agent that forked it, so this ring holds
			// nothing before the line saying it ended.
			logs:  NewRing(r.opts.LogLines),
			ended: make(chan struct{}),
			state: contract.InstanceStarting,
		}
		r.instances[rec.InstanceID] = inst
		go r.reap(inst)

		r.opts.Log.Info("instance adopted",
			"instanceId", rec.InstanceID, "sessionId", rec.SessionID, "pid", rec.PID)
	}
	return nil
}

// Watch polls every child on an interval, which is the only way this box learns a state changed.
func (r *Registry) Watch(ctx context.Context, every time.Duration) {
	tick := time.NewTicker(every)
	defer tick.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			r.Poll(ctx)
		}
	}
}

// Poll asks every child how it is, once. The state that reaches a report is this box's own reading
// of the process, never a claim the process made about itself.
func (r *Registry) Poll(ctx context.Context) {
	// Concurrent, and each child timed at the moment it is asked: one wedged child must not age
	// every other reading in the cycle, nor the grace those readings are tested against.
	var probing sync.WaitGroup
	for _, inst := range r.snapshot() {
		probing.Add(1)
		go func() {
			defer probing.Done()
			r.probe(ctx, inst, time.Now())
		}()
	}
	probing.Wait()

	r.sweep(time.Now())
}

func (r *Registry) probe(ctx context.Context, inst *instance, now time.Time) {
	if inst.done() {
		inst.mark(contract.InstanceUnhealthy)
		return
	}

	vitals, requestID, err := r.opts.Prober.Probe(ctx, inst.addr)

	inst.mu.Lock()
	defer inst.mu.Unlock()

	// A drain is this agent's own decision, and no probe overrides it.
	if inst.state == contract.InstanceDraining {
		return
	}
	if err == nil {
		inst.state = contract.InstanceHealthy
		inst.players = vitals.Players
		return
	}
	// A process that has not bound its port yet is starting, not failing — but only for as long as
	// a boot takes.
	if inst.state == contract.InstanceStarting && now.Sub(inst.startedAt) < r.opts.StartGrace {
		return
	}
	// Once per transition rather than once per poll, so a box that is down for an hour is one
	// account of why — under the id the child logged the refused probe against.
	if inst.state != contract.InstanceUnhealthy {
		r.opts.Log.Warn("instance unhealthy",
			"err", err, "instanceId", inst.id, "requestId", requestID)
	}
	inst.state = contract.InstanceUnhealthy
}

// sweep forgets instances whose retention has run out, so a long-lived box does not accumulate the
// dead forever.
func (r *Registry) sweep(now time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()

	for id, inst := range r.instances {
		inst.mu.Lock()
		stale := inst.exited && now.Sub(inst.endedAt) >= r.opts.Retention
		inst.mu.Unlock()

		if stale {
			delete(r.instances, id)
		}
	}
}

// Stop drains the child and waits for it to end, so a 204 means this session's saves are written.
//
// The teardown runs on its own goroutine rather than the caller's context, and the entry is dropped
// only once the child has actually ended: a client that hangs up mid-drain must not leave a live
// process with no entry naming it, which is a port this box could never account for again.
func (r *Registry) Stop(ctx context.Context, id string) error {
	r.mu.Lock()
	inst, ok := r.instances[id]
	r.mu.Unlock()
	if !ok {
		return ErrUnknown
	}

	inst.stopOnce.Do(func() { go r.teardown(inst) })

	select {
	case <-inst.ended:
	case <-ctx.Done():
		return ctx.Err()
	}

	r.mu.Lock()
	delete(r.instances, id)
	r.mu.Unlock()

	r.opts.Log.Info("instance stopped", "instanceId", id, "sessionId", inst.sessionID)
	return nil
}

// teardown gives the drain its budget and then takes the process anyway: the port was asked for
// back, and a child that ignored one signal will not answer the next.
func (r *Registry) teardown(inst *instance) {
	if inst.done() {
		return
	}

	inst.mark(contract.InstanceDraining)
	if err := inst.child.Drain(); err != nil {
		r.opts.Log.Warn("drain refused", "instanceId", inst.id, "err", err)
		_ = inst.child.Kill()
	}

	select {
	case <-inst.ended:
	case <-time.After(r.opts.StopTimeout):
		// Not waited on again: `reap` closes `ended` when the process actually goes, and a child
		// that survives a kill is a fact for the next probe rather than a goroutine held here.
		_ = inst.child.Kill()
	}
}

// List is every instance this box holds, oldest first, so a page of them reads as a timeline.
func (r *Registry) List() []View {
	now := time.Now()
	held := r.snapshot()

	out := make([]View, 0, len(held))
	for _, inst := range held {
		out = append(out, inst.view(now))
	}
	return out
}

// Get is one instance, whether it is still running or only still remembered.
func (r *Registry) Get(id string) (View, error) {
	r.mu.Lock()
	inst, ok := r.instances[id]
	r.mu.Unlock()
	if !ok {
		return View{}, ErrUnknown
	}
	return inst.view(time.Now()), nil
}

// Logs is the tail of one child's output, oldest first.
func (r *Registry) Logs(id string, limit int) ([]string, error) {
	r.mu.Lock()
	inst, ok := r.instances[id]
	r.mu.Unlock()
	if !ok {
		return nil, ErrUnknown
	}
	return inst.logs.Lines(limit), nil
}

// Live is what the heartbeat carries: one report per child this box still holds a process for. A
// reaped one is absent rather than reported dead, so the fleet reads a whole box from one beat.
func (r *Registry) Live() []contract.InstanceReport {
	now := time.Now()
	held := r.snapshot()

	out := make([]contract.InstanceReport, 0, len(held))
	for _, inst := range held {
		if inst.done() {
			continue
		}
		out = append(out, inst.view(now).InstanceReport)
	}
	return out
}

// Running counts the processes this box is actually holding, which is what its capacity is against.
func (r *Registry) Running() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.running()
}

// Max is the cap this box was configured with.
func (r *Registry) Max() int {
	return r.opts.MaxInstances
}

// StopTimeout is how long a drain may hold Stop, which is what a caller has to give its response.
func (r *Registry) StopTimeout() time.Duration {
	return r.opts.StopTimeout
}

func (r *Registry) running() int {
	live := 0
	for _, inst := range r.instances {
		if !inst.done() {
			live++
		}
	}
	return live
}

func (r *Registry) snapshot() []*instance {
	r.mu.Lock()
	held := make([]*instance, 0, len(r.instances))
	for _, inst := range r.instances {
		held = append(held, inst)
	}
	r.mu.Unlock()

	// A map's order is deliberately unstable, and this list is read by a person.
	sort.Slice(held, func(a, b int) bool {
		if held[a].startedAt.Equal(held[b].startedAt) {
			return held[a].id < held[b].id
		}
		return held[a].startedAt.Before(held[b].startedAt)
	})
	return held
}

func (i *instance) view(now time.Time) View {
	i.mu.Lock()
	defer i.mu.Unlock()

	return View{
		InstanceReport: contract.InstanceReport{
			InstanceID:    i.id,
			GameID:        i.gameID,
			SessionID:     i.sessionID,
			State:         i.state,
			Players:       i.players,
			UptimeSeconds: int64(now.Sub(i.startedAt).Seconds()),
			Port:          i.port,
		},
	}
}

func (i *instance) mark(state contract.InstanceState) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.state = state
}

func (i *instance) done() bool {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.exited
}
