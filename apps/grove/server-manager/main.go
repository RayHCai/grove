// The composition root: the environment, the registry, the policy that ranks boxes, the line joins
// wait in, and the listener.
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/RayHCai/grove/apps/grove/server-manager/internal/api"
	"github.com/RayHCai/grove/apps/grove/server-manager/internal/config"
	"github.com/RayHCai/grove/apps/grove/server-manager/internal/fleet"
	"github.com/RayHCai/grove/apps/grove/server-manager/internal/joins"
	"github.com/RayHCai/grove/libs/go-grove/env"
	"github.com/RayHCai/grove/libs/go-grove/httpx"
)

func main() {
	cfg, err := config.Read(env.New())
	if err != nil {
		// Straight to stderr, because which handler the logger takes is itself config's answer.
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	log := env.Logger(cfg.Env, os.Stdout)

	// The map behind the mutex is the seam a datastore lands on: a second replica of this service
	// must share one registry rather than each holding half the fleet.
	registry := fleet.NewRegistry(cfg.StaleAfter)
	// Both callers bound their own call; the timeout is the backstop for a redeploy and a start alike.
	agent := fleet.HTTPAgent{Client: &http.Client{Timeout: cfg.AgentTimeout}, Secret: cfg.FleetSecret}
	line := joins.New(joins.Options{
		Placer: &fleet.Router{
			Registry:     registry,
			Balancer:     fleet.MostFree{},
			Ingress:      fleet.ProxyIngress{},
			Agent:        agent,
			StoreKey:     cfg.StoreKey,
			StartTimeout: cfg.StartTimeout,
			SuspectFor:   cfg.SuspectFor,
			Log:          log,
			Now:          time.Now,
		},
		Log:          log,
		Deadline:     cfg.JoinDeadline,
		Depth:        cfg.JoinQueueDepth,
		StartWorkers: cfg.StartWorkers,
	})

	// The registry is rebuilt from one interval of beats, which is why it can live in memory. What
	// no later beat carries is what the fleet did, so the transitions go where they outlive this
	// process.
	reporter := fleet.NewReporter(fleet.ReporterOptions{
		APIURL:   cfg.APIURL,
		Secret:   cfg.CallerSecret,
		Fleet:    registry,
		Interval: cfg.ReportInterval,
		Timeout:  cfg.AgentTimeout,
		Log:      log,
		Now:      time.Now,
	})
	if !reporter.Attached() {
		log.Warn("no API_URL: the fleet's history is kept in this process and nowhere else")
	}

	// Started before the listener, so nothing can be waiting on a line nobody is reading.
	answering, stop := context.WithCancel(context.Background())
	answered := make(chan struct{})
	go func() {
		defer close(answered)
		line.Run(answering)
	}()

	go reporter.Run(answering, registry.Sweep)

	server := api.New(api.Options{
		Registry:      registry,
		Joins:         line,
		Agent:         agent,
		FleetSecret:   cfg.FleetSecret,
		CallerSecret:  cfg.CallerSecret,
		Production:    cfg.Env == "production",
		Warmup:        cfg.PlacementWarmup,
		SuspectFor:    cfg.SuspectFor,
		Log:           log,
		DeployTimeout: cfg.DeployTimeout,
		HostTimeout:   cfg.AgentTimeout,
	})

	serveErr := httpx.Serve(context.Background(), cfg.Addr(), server.Handler(), log)

	// Stopped only once the listener has drained, because every handler still inside that drain is
	// waiting on the line.
	stop()
	<-answered

	if serveErr != nil {
		log.Error("serve", "err", serveErr)
		os.Exit(1)
	}
}
