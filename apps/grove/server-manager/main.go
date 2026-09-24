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
	cfg, err := config.Load(env.New())
	if err != nil {
		// Straight to stderr, because which handler the logger takes is itself config's answer.
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	log := env.Logger(cfg.Env, os.Stdout)

	queue, err := lineFor(cfg)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	// The map behind the mutex is the seam a datastore lands on: a second replica of this service
	// must share one registry rather than each holding half the fleet.
	registry := fleet.NewRegistry(cfg.StaleAfter)
	// One agent for both callers: a redeploy fans out over it and a join starts one world through
	// it, and both reach a box the same way.
	agent := fleet.HTTPAgent{Client: &http.Client{}, Secret: cfg.FleetSecret}
	line := joins.New(joins.Options{
		Queue: queue,
		Placer: fleet.Router{
			Registry:     registry,
			Balancer:     fleet.MostFree{},
			Ingress:      fleet.DirectIngress{Scheme: cfg.IngressScheme},
			Agent:        agent,
			StartTimeout: cfg.StartTimeout,
			Log:          log,
			Now:          time.Now,
		},
		Log:      log,
		Deadline: cfg.JoinDeadline,
	})

	// The registry is rebuilt from one interval of beats, which is why it can live in memory. What
	// no later beat carries is what the fleet did, so the transitions go where they outlive this
	// process.
	reporter := fleet.NewReporter(fleet.ReporterOptions{
		APIURL:      cfg.APIURL,
		FleetSecret: cfg.FleetSecret,
		Fleet:       registry,
		Interval:    cfg.ReportInterval,
		Timeout:     cfg.AgentTimeout,
		Log:         log,
		Now:         time.Now,
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
		Secret:        cfg.FleetSecret,
		Log:           log,
		DeployTimeout: cfg.DeployTimeout,
		HostTimeout:   cfg.AgentTimeout,
	})

	serveErr := httpx.Serve(context.Background(), cfg.Addr, server.Handler(), log)

	// Stopped only once the listener has drained, because every handler still inside that drain is
	// waiting on this worker — and the line is released once the worker has certainly stopped
	// reading it, rather than out from under a pop still in flight.
	stop()
	<-answered
	queue.Close()

	if serveErr != nil {
		log.Error("serve", "err", serveErr)
		os.Exit(1)
	}
}

// lineFor holds the line in the cache this deployment named, or in this process when it named none.
func lineFor(cfg config.Config) (joins.Queue, error) {
	if cfg.JoinQueueURL == "" {
		return joins.NewMemory(cfg.JoinQueueDepth), nil
	}
	return joins.NewRedis(cfg.JoinQueueURL, cfg.JoinQueueKey, cfg.JoinQueueDepth, cfg.JoinDeadline)
}
