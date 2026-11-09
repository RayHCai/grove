// The composition root: the environment this box was configured with, the supervisor its routes
// drive, the beat it sends upward, and the two listeners that drain on the way down.
package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/RayHCai/grove/apps/grove/instance-manager/internal/box"
	"github.com/RayHCai/grove/apps/grove/instance-manager/internal/bundles"
	"github.com/RayHCai/grove/apps/grove/instance-manager/internal/config"
	"github.com/RayHCai/grove/apps/grove/instance-manager/internal/heartbeat"
	"github.com/RayHCai/grove/apps/grove/instance-manager/internal/proxy"
	"github.com/RayHCai/grove/apps/grove/instance-manager/internal/server"
	"github.com/RayHCai/grove/apps/grove/instance-manager/internal/supervisor"
	"github.com/RayHCai/grove/libs/go-grove/env"
	"github.com/RayHCai/grove/libs/go-grove/httpx"
)

// How often each child is asked how it is, and how long one answer may take. Both well under the
// heartbeat interval, so what a beat carries is a reading and not a memory.
const (
	pollInterval = 2 * time.Second
	probeTimeout = 2 * time.Second
	// Short: this one sits between a drained listener and the process ending, and a box that cannot
	// reach the router in this long is one the router is about to stop hearing from anyway.
	farewellTimeout = 3 * time.Second
	// Minutes, because the download is detached from the start whose join the router gave up on.
	bundleFetchTimeout = 2 * time.Minute
)

func main() {
	cfg, err := config.Read(env.New())
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	log := env.Logger(cfg.Env, os.Stdout)

	// Read before the cgroup is claimed, so a bad pair exits with nothing yet to hand back.
	var certs *tls.Config
	if cfg.TLS() {
		if certs, err = httpx.CertFiles(cfg.TLSCertFile, cfg.TLSKeyFile, log); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}

	sandbox := supervisor.Sandbox{
		UID:        cfg.GameUID,
		GID:        cfg.GameGID,
		CgroupRoot: cfg.CgroupRoot,
		MemoryMax:  cfg.ChildMemoryMaxBytes,
		PidsMax:    cfg.ChildPidsMax,
	}
	// A child on this agent's own uid could read this agent's environment, which holds the fleet secret.
	if cfg.GameUID != 0 && cfg.GameUID == os.Getuid() {
		fmt.Fprintln(os.Stderr, "GAME_UID must not be the uid this agent runs as")
		os.Exit(1)
	}
	if err := sandbox.Claim(); err != nil {
		fmt.Fprintln(os.Stderr, "claim the child cgroup:", err)
		os.Exit(1)
	}

	disk := bundles.Disk{Dir: cfg.BundleDir, Client: &http.Client{Timeout: bundleFetchTimeout}}
	// The seams are chosen here and nowhere else: what forks a process, what asks one how it is,
	// which port it binds, where its code comes from, and what the machine has left.
	instances := supervisor.New(supervisor.Options{
		Launcher:            supervisor.NewExecLauncher(cfg.GameInstanceBin, sandbox),
		Prober:              supervisor.NewHTTPProber(probeTimeout),
		Ports:               supervisor.NewKernelPorts(),
		Bundles:             disk,
		FetchTimeout:        bundleFetchTimeout,
		ManagerURL:          cfg.GameManagerURL,
		Log:                 log,
		MaxInstances:        cfg.MaxInstances,
		TicketPublicKeys:    cfg.TicketPublicKeys,
		StateDir:            cfg.StateDir,
		DrainDeadline:       cfg.DrainDeadline,
		ReapIdle:            cfg.ReapIdle,
		ReapUnhealthyProbes: cfg.ReapUnhealthyProbes,
		ReapTokenMargin:     cfg.ReapTokenMargin,
		// Two beats, so the one carrying a drain this box began has reached the router first.
		DrainNotice: 2 * cfg.HeartbeatInterval,
	})

	// Before anything can be placed here, or the first start of this boot would be weighed against
	// a box that only looks empty.
	if err := instances.Adopt(); err != nil {
		log.Error("adopt", "err", err)
	}

	// What a box needs before it can start a world: a binary to fork and a cache to land code in.
	ready := func(ctx context.Context) error {
		if err := supervisor.ExecReady(cfg.GameInstanceBin)(ctx); err != nil {
			return err
		}
		return disk.Ready(ctx)
	}

	beater := heartbeat.New(heartbeat.Options{
		ServerManagerURL: cfg.ServerManagerURL,
		FleetSecret:      cfg.FleetSecret,
		HostID:           cfg.HostID,
		Region:           cfg.Region,
		AgentPort:        cfg.Port,
		PublicHost:       cfg.PublicHost,
		PlayerPort:       cfg.PlayerPort,
		TLS:              cfg.TLS(),
		Ready:            ready,
		Interval:         cfg.HeartbeatInterval,
		Source:           instances,
		Box:              box.NewProcSampler(),
		Log:              log,
	})

	// Cancelled once the listener has drained, which stops the poller and the beat. The children
	// are left running: a game in progress outlives the agent that started it, and a redeploy of
	// this agent must not end anyone's session.
	ctx, stop := context.WithCancel(context.Background())
	defer stop()

	go instances.Watch(ctx, pollInterval)
	beating := make(chan struct{})
	go func() {
		defer close(beating)
		beater.Run(ctx)
	}()

	// One certificate for both: the router dials the control port and players the proxy, by one name.
	err = httpx.ServeAll(ctx, log,
		httpx.Listener{
			Addr:    cfg.Addr(),
			Handler: server.New(instances, ready, cfg.FleetSecret, cfg.HostID, log),
			TLS:     certs,
		},
		httpx.Listener{
			Addr:          cfg.PlayerAddr(),
			Handler:       proxy.New(instances, log),
			TLS:           certs,
			MaxConns:      cfg.PlayerMaxConnections,
			HeaderTimeout: proxy.HeaderTimeout,
		},
	)

	// After the listener has drained and before this process is gone: one beat saying the box is
	// leaving deliberately. Silence is how the router finds a crash, so a deploy that just went
	// quiet would read as one, and the ticker above is stopped and waited for so no ordinary beat
	// still in flight can land after this one and say nothing of the sort.
	stop()
	<-beating
	farewell, done := context.WithTimeout(context.Background(), farewellTimeout)
	defer done()
	if requestID, ferr := beater.Farewell(farewell); ferr != nil {
		log.Warn("farewell failed", "err", ferr, "hostId", cfg.HostID, "requestId", requestID)
	}
	// Last, since systemd cannot attach the next run to the unit while the controllers are on.
	if yerr := sandbox.Yield(); yerr != nil {
		log.Warn("yield the child cgroup", "err", yerr)
	}

	if err != nil {
		log.Error("serve", "err", err)
		os.Exit(1)
	}
}
