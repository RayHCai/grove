// The composition root: the environment this box was configured with, the supervisor its routes
// drive, the beat it sends upward, and the listener that drains what is in flight on the way down.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/RayHCai/grove/apps/grove/instance-manager/internal/box"
	"github.com/RayHCai/grove/apps/grove/instance-manager/internal/config"
	"github.com/RayHCai/grove/apps/grove/instance-manager/internal/heartbeat"
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
)

func main() {
	cfg, err := config.Read(env.New())
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel()}))

	// The three seams are chosen here and nowhere else: what forks a process, what asks one how it
	// is, and what decides which port it binds.
	instances := supervisor.New(supervisor.Options{
		Launcher:     supervisor.NewExecLauncher(cfg.GameInstanceBin),
		Prober:       supervisor.NewHTTPProber(probeTimeout),
		Ports:        supervisor.NewKernelPorts(),
		Log:          log,
		MaxInstances: cfg.MaxInstances,
		TokenSecret:  cfg.GameTokenSecret,
	})

	beater := heartbeat.New(heartbeat.Options{
		ServerManagerURL: cfg.ServerManagerURL,
		FleetSecret:      cfg.FleetSecret,
		HostID:           cfg.HostID,
		Region:           cfg.Region,
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
	go beater.Run(ctx)

	// The one thing about this agent that is not true the moment it binds: a deploy that left the
	// game binary missing takes every start request and fails it.
	ready := supervisor.ExecReady(cfg.GameInstanceBin)

	handler := server.New(instances, ready, cfg.FleetSecret, log)
	if err := httpx.Serve(ctx, cfg.Addr(), handler, log); err != nil {
		log.Error("serve", "err", err)
		os.Exit(1)
	}
}
